import { describe, expect, it } from "vitest";
import {
  countFailedQuests,
  countSuccessfulQuests,
} from "../../apps/server/src/game/rules";
import { GameController } from "../../apps/server/src/controller/controller";
import { toPublicGameView } from "../../apps/server/src/game/views";
import {
  DIRECTED_DIALOGUE_MAX_EXCHANGES,
  defaultConfig,
  type GameConfig,
  type PlayerAction,
  type PlayerId,
  type PromptType,
} from "@avalon/shared";
import type { ServerConfig } from "../../apps/server/src/config";

const server: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  webOrigin: true,
  gateway: { baseUrl: "", apiKey: "" },
  forceMock: true,
  modelTimeoutMs: 1000,
  persist: false,
  dataDir: "/tmp/none",
  reasoningEffort: "medium",
};

function makeGame(seed: number, extra: Partial<GameConfig> = {}): GameController {
  const config: GameConfig = { ...defaultConfig(), mock: true, seed, ...extra };
  return new GameController(`g_${seed}`, config, server);
}

function roleSeat(g: GameController, role: string): PlayerId {
  return Object.values(g.state.players).find((p) => p.role === role)!.id;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function prepareInterruptCollect(g: GameController): void {
  g.state.status = "paused";
  g.state.phase = "interrupt_collect";
  g.state.round.current_speaker = "C";
  g.state.round.next_normal_speaker = "D";
  g.state.round.normal_queue = ["D"];
  g.state.round.leader = "G";
  g.state.interrupts.phase_budget_remaining = 8;
  for (const p of ["E", "F", "G"] as const) {
    g.state.talk_stats[p].interrupts_in_phase = 2;
  }
}

describe("full mock game runs to a valid conclusion", () => {
  it("terminates with a winner for many seeds, honoring win conditions", async () => {
    const winners = new Set<string>();
    for (let seed = 1; seed <= 16; seed++) {
      const g = makeGame(seed);
      await g.runToCompletion();
      const s = g.state;

      expect(s.status).toBe("completed");
      expect(s.phase).toBe("game_over");
      expect(s.winner === "good" || s.winner === "evil").toBe(true);
      expect(s.event_log.some((e) => e.type === "game_over")).toBe(true);
      winners.add(s.winner!);

      const success = countSuccessfulQuests(s.quests);
      const fails = countFailedQuests(s.quests);

      const assassination = s.event_log.find((e) => e.type === "assassination_attempt");
      if (assassination && assassination.type === "assassination_attempt") {
        // Good must have reached 3 quests to trigger assassination.
        expect(success).toBeGreaterThanOrEqual(3);
        // Winner is decided by whether the Assassin found Merlin.
        expect(s.winner).toBe(assassination.target_was_merlin ? "evil" : "good");
      } else if (s.winner === "evil") {
        // Evil won by quests or by 5 rejections.
        const byQuests = fails >= 3;
        const byRejections = (s.game_over_reason ?? "").includes("否决");
        expect(byQuests || byRejections).toBe(true);
      }
    }
    expect(winners.size).toBeGreaterThanOrEqual(1);
  });

  it("never leaks roles into the public view mid-game", async () => {
    const g = makeGame(42);
    // step partway through
    for (let i = 0; i < 25 && !g.isOver(); i++) await g.step();
    const pub = toPublicGameView(g.state);
    for (const p of pub.players) {
      expect(Object.keys(p)).not.toContain("role");
      expect(Object.keys(p)).not.toContain("alignment");
    }
    const types = pub.public_event_log.map((e) => e.type);
    expect(types).not.toContain("role_assigned");
    expect(types).not.toContain("vote_cast");
    expect(types).not.toContain("mission_card_submitted");
    expect(types).not.toContain("model_raw_response");
    expect(types).not.toContain("private_memo");
  });

  it("reveals roles and runs one post-game review per seat only after requested", async () => {
    const g = makeGame(18);
    await g.runToCompletion();

    const before = toPublicGameView(g.state);
    expect(before.revealed_identities).toBeNull();
    expect(before.postgame_review.status).toBe("not_started");
    expect(before.public_event_log.some((e) => e.type === "postgame_roles_revealed")).toBe(false);

    expect(g.startPostgameReview().ok).toBe(true);
    await waitFor(
      () => g.state.postgame_review.status === "completed",
      "all-AI postgame review",
    );

    const after = toPublicGameView(g.state);
    expect(g.state.status).toBe("completed");
    expect(g.state.phase).toBe("game_over");
    expect(after.revealed_identities).not.toBeNull();
    for (const id of g.state.seat_order) {
      expect(after.revealed_identities?.[id]).toEqual({
        role: g.state.players[id].role,
        alignment: g.state.players[id].alignment,
      });
    }

    const revealEvents = after.public_event_log.filter((e) => e.type === "postgame_roles_revealed");
    expect(revealEvents).toHaveLength(1);
    const reviewSpeeches = after.public_event_log.filter(
      (e) => e.type === "public_speech" && e.source === "postgame_review",
    );
    expect(reviewSpeeches.map((e) => (e.type === "public_speech" ? e.player : null))).toEqual(
      g.state.seat_order,
    );
    expect(after.postgame_review.status).toBe("completed");
    expect(after.postgame_review.completed_players).toEqual(g.state.seat_order);

    const eventCount = g.state.event_log.length;
    expect(g.startPostgameReview().ok).toBe(true);
    await delay(20);
    expect(g.state.event_log).toHaveLength(eventCount);
  });

  it("is deterministic for a fixed seed", async () => {
    const a = makeGame(7);
    const b = makeGame(7);
    await a.runToCompletion();
    await b.runToCompletion();
    expect(a.state.winner).toBe(b.state.winner);
    expect(a.state.event_log.length).toBe(b.state.event_log.length);
    expect(a.state.game_over_reason).toBe(b.state.game_over_reason);
  });

  it("produces a 5-rejection evil win when all teams are rejected", async () => {
    // evil_fail_probability irrelevant here; we force rejections via a stub adapter.
    const g = makeGame(3);
    // Monkeypatch the adapter to always reject votes and pass otherwise.
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: string; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        const pt = input.prompt_type;
        const action =
          pt === "vote"
            ? { action: "vote", approve: false }
            : pt === "leader_discussion"
              ? { action: "speak", target: null, speech: "先听一圈。" }
            : pt === "leader_proposal"
              ? { action: "propose_team", team: ["A", "B"], speech: "x" }
              : pt === "full_speech"
                ? { action: "speak", target: null, speech: "x" }
                : pt === "mission"
                  ? { action: "mission_card", card: "success" }
                  : pt === "assassination"
                    ? { action: "assassinate", target: "A", speech: "x" }
                    : { action: "pass" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };
    await g.runToCompletion();
    expect(g.state.status).toBe("completed");
    expect(g.state.winner).toBe("evil");
    expect(g.state.game_over_reason ?? "").toContain("否决");
  });

  it("opens an interrupt window after a leader proposal speech, then finalizes the team", async () => {
    const g = makeGame(88);
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        const action =
          input.prompt_type === "leader_proposal"
            ? { action: "propose_team", team: ["A", "B"], speech: "我带自己和B先试一车。" }
            : input.prompt_type === "interrupt_intent"
              ? { action: "pass" }
              : input.prompt_type === "full_speech"
                ? { action: "speak", target: null, speech: "我接着聊。" }
                : { action: "pass" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    g.state.status = "paused";
    g.state.phase = "leader_proposal";
    g.state.round.leader = "A";

    await g.step();
    const leaderSpeech = g.state.event_log.find(
      (e) => e.type === "public_speech" && e.player === "A" && e.source === "leader_final",
    );
    expect(leaderSpeech).toBeTruthy();
    expect(g.state.phase).toBe("interrupt_collect");
    expect(g.state.round.current_speaker).toBe("A");
    expect(g.state.round.next_normal_speaker).toBe(null);

    await g.step();
    expect(g.state.phase).toBe("team_finalize");
    expect(g.state.round.proposed_team).toEqual(["A", "B"]);
  });

  it("starts each proposal attempt with discussion and lets the leader speak first", async () => {
    const g = makeGame(120);
    const leader = g.state.round.leader;

    await g.step();

    expect(g.state.phase).toBe("discussion");
    expect(g.state.round.normal_queue[0]).toBe(leader);
    expect(g.state.round.next_normal_speaker).toBe(leader);
    expect(g.state.round.proposed_team).toBe(null);
  });

  it("continues to the next speaker when the leader discusses instead of proposing", async () => {
    const g = makeGame(121, { interrupt_window_ms: 50 });
    g.state.status = "paused";
    g.state.phase = "discussion";
    g.state.round.leader = "A";
    g.state.round.normal_queue = ["A", "B", "C"];
    g.state.round.next_normal_speaker = "A";
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        const action =
          input.prompt_type === "leader_discussion"
            ? { action: "speak", target: null, speech: "我先听意见。" }
            : input.prompt_type === "interrupt_intent"
              ? { action: "pass" }
              : { action: "speak", target: null, speech: "普通发言。" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    await g.step();
    expect(g.state.phase).toBe("interrupt_collect");
    expect(g.state.round.current_speaker).toBe("A");
    expect(g.state.round.next_normal_speaker).toBe("B");

    await g.step();
    expect(g.state.phase).toBe("discussion");
    expect(g.state.round.next_normal_speaker).toBe("B");
    expect(g.state.round.proposed_team).toBe(null);
  });

  it("lets the leader propose during discussion while remaining players still discuss before voting", async () => {
    const g = makeGame(122);
    g.state.status = "paused";
    g.state.phase = "discussion";
    g.state.round.leader = "A";
    g.state.round.normal_queue = ["A", "B", "C"];
    g.state.round.next_normal_speaker = "A";
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        const action =
          input.prompt_type === "leader_discussion"
            ? { action: "propose_team", team: ["A", "B"], speech: "我正式发 A-B。" }
            : input.prompt_type === "full_speech" || input.prompt_type === "full_speech_optional"
              ? { action: "speak", target: null, speech: `${input.player_id} 先评价这辆车。` }
              : { action: "pass" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    await g.step();

    expect(g.state.phase).toBe("interrupt_collect");
    expect(g.state.round.proposed_team).toEqual(["A", "B"]);
    expect(g.state.round.normal_queue).toEqual(["B", "C"]);
    expect(g.state.round.next_normal_speaker).toBe("B");
    expect(g.state.event_log.some((e) => e.type === "team_proposed" && e.leader === "A")).toBe(true);

    await g.step();
    expect(g.state.phase).toBe("discussion");
    expect(g.state.round.next_normal_speaker).toBe("B");

    await g.step();
    expect(g.state.phase).toBe("interrupt_collect");
    expect(g.state.round.normal_queue).toEqual(["C"]);
    expect(g.state.event_log.some((e) => e.type === "public_speech" && e.player === "B")).toBe(true);

    await g.step();
    await g.step();
    expect(g.state.phase).toBe("interrupt_collect");
    expect(g.state.round.normal_queue).toEqual([]);
    expect(g.state.event_log.some((e) => e.type === "public_speech" && e.player === "C")).toBe(true);

    await g.step();
    expect(g.state.phase).toBe("team_finalize");
  });

  it("forces the leader to propose after one full discussion round", async () => {
    const g = makeGame(123, { interrupt_window_ms: 10 });
    const prompts: string[] = [];
    g.state.status = "paused";
    g.state.phase = "discussion";
    g.state.round.leader = "A";
    g.state.round.normal_queue = ["A", "B"];
    g.state.round.next_normal_speaker = "A";
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        prompts.push(`${input.player_id}:${input.prompt_type}`);
        const action =
          input.prompt_type === "interrupt_intent"
            ? { action: "pass" }
            : { action: "speak", target: null, speech: "先不定车。" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    for (let i = 0; i < 6 && g.state.phase !== "leader_proposal"; i++) await g.step();

    expect(g.state.phase).toBe("leader_proposal");
    expect(g.state.round.current_speaker).toBe(null);
    expect(prompts).toContain("A:leader_discussion");
    expect(prompts).toContain("B:full_speech_optional");
  });

  it("rejects a non-leader structured proposal and falls back to speech", async () => {
    const g = makeGame(124);
    g.state.status = "paused";
    g.state.phase = "discussion";
    // Round 2+ so the non-leader gets the mandatory full_speech prompt (round-1
    // uses full_speech_optional, whose fallback is a pass, not a speech).
    g.state.round.quest_index = 1;
    g.state.round.leader = "A";
    g.state.round.normal_queue = ["B"];
    g.state.round.next_normal_speaker = "B";
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async () => {
        const action = { action: "propose_team", team: ["A", "B"], speech: "我也想发车。" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    await g.step();

    expect(g.state.round.proposed_team).toBe(null);
    expect(g.state.event_log.some((e) => e.type === "model_action_rejected" && e.player === "B")).toBe(true);
    const speech = g.state.event_log.find((e) => e.type === "public_speech" && e.player === "B");
    expect(speech?.type).toBe("public_speech");
  });

  it("lets a non-leader pass their round-1 discussion turn and advances the rotation", async () => {
    const g = makeGame(125, { interrupt_window_ms: 10 });
    const prompts: string[] = [];
    g.state.status = "paused";
    g.state.phase = "discussion";
    g.state.round.quest_index = 0; // round 1 → optional speech
    g.state.round.leader = "A";
    g.state.round.normal_queue = ["B", "C"];
    g.state.round.next_normal_speaker = "B";
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        prompts.push(`${input.player_id}:${input.prompt_type}`);
        const action = { action: "pass" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    await g.step();

    // B was asked with the optional-speech prompt and chose to pass.
    expect(prompts).toContain("B:full_speech_optional");
    expect(g.state.event_log.some((e) => e.type === "speech_passed" && e.player === "B")).toBe(true);
    expect(g.state.event_log.some((e) => e.type === "public_speech" && e.player === "B")).toBe(false);
    // A pass opens no interrupt window; the rotation moves straight to C.
    expect(g.state.phase).toBe("discussion");
    expect(g.state.round.normal_queue).toEqual(["C"]);
    expect(g.state.round.next_normal_speaker).toBe("C");
  });

  it("grants the first same-priority interrupt without waiting for slower APIs", async () => {
    const g = makeGame(89, { interrupt_window_ms: 1000 });
    prepareInterruptCollect(g);
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        const action =
          input.player_id === "A"
            ? { action: "request_interrupt", target: "C", speech: "我先抢。" }
            : input.player_id === "B"
              ? (await delay(800), { action: "request_interrupt", target: "C", speech: "我迟到了。" })
              : { action: "pass" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    const started = Date.now();
    await g.step();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(300);
    expect(g.state.phase).toBe("interrupt_speech");
    expect(g.state.interrupts.granted?.player).toBe("A");
    expect(g.state.event_log.some((e) => e.type === "interrupt_requested" && e.player === "A")).toBe(true);

    await delay(850);
    const requested = g.state.event_log.filter((e) => e.type === "interrupt_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.player).toBe("A");
  });

  it("waits for a higher-priority interrupt and grants it over a faster low-priority request", async () => {
    const g = makeGame(90, { interrupt_window_ms: 1000 });
    prepareInterruptCollect(g);
    g.state.talk_stats.A.interrupts_in_phase = 1;
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        const action =
          input.player_id === "A"
            ? { action: "request_interrupt", target: "C", speech: "低优先级先到。" }
            : input.player_id === "B"
              ? (await delay(60), { action: "request_interrupt", target: "C", speech: "高优先级后来。" })
              : { action: "pass" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    const started = Date.now();
    await g.step();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(300);
    expect(g.state.phase).toBe("interrupt_speech");
    expect(g.state.interrupts.granted?.player).toBe("B");
    expect(g.state.event_log.some((e) => e.type === "interrupt_rejected" && e.player === "A")).toBe(true);
  });

  it("grants a lower-priority interrupt once higher-priority players pass", async () => {
    const g = makeGame(91, { interrupt_window_ms: 1000 });
    prepareInterruptCollect(g);
    g.state.talk_stats.A.interrupts_in_phase = 1;
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        const action =
          input.player_id === "A"
            ? { action: "request_interrupt", target: "C", speech: "我先排队。" }
            : input.player_id === "B"
              ? (await delay(60), { action: "pass" })
              : { action: "pass" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    const started = Date.now();
    await g.step();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(300);
    expect(g.state.phase).toBe("interrupt_speech");
    expect(g.state.interrupts.granted?.player).toBe("A");
  });

  it("tells an accused player when an interrupt window follows a direct public accusation", async () => {
    const g = makeGame(125, { interrupt_window_ms: 100 });
    const contextByPlayer = new Map<PlayerId, string | undefined>();
    g.state.status = "paused";
    g.state.phase = "interrupt_collect";
    g.state.round.leader = "C";
    g.state.round.current_speaker = "C";
    g.state.round.next_normal_speaker = "D";
    g.state.round.normal_queue = ["D", "E"];
    g.state.interrupts.phase_budget_remaining = 8;
    g.state.quests[0] = {
      ...g.state.quests[0]!,
      result: "fail",
      fail_count: 1,
      team: ["B", "C"],
      leader: "C",
    };
    g.state.event_log.push({
      type: "public_speech",
      event_id: "evt_accuse_b",
      timestamp: Date.now(),
      player: "C",
      target: null,
      speech: "我打的是成功,所以B有问题。",
      source: "normal",
    });
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: PlayerId; context_note?: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        if (input.prompt_type === "interrupt_intent") {
          contextByPlayer.set(input.player_id, input.context_note);
        }
        const action = { action: "pass" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    await g.step();

    expect(contextByPlayer.get("B")).toContain("刚才玩家C的发言提到并质疑了你");
    expect(contextByPlayer.get("B")).toContain("二人失败车互扣锅场景");
    expect(contextByPlayer.get("A")).toBeUndefined();
  });

  it("lets the Assassin directly assassinate on their second council turn", async () => {
    const g = makeGame(92);
    const assassin = roleSeat(g, "Assassin");
    const merlin = roleSeat(g, "Merlin");
    const otherEvil = g.state.seat_order.filter(
      (id) => g.state.players[id].alignment === "evil" && id !== assassin,
    );
    const prompts: PromptType[] = [];
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        prompts.push(input.prompt_type);
        const action = { action: "assassinate", target: merlin, speech: "我现在直接指。", memo: "第二轮已足够。" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    g.state.status = "paused";
    g.state.phase = "assassination_discuss";
    g.state.round.normal_queue = [assassin, ...otherEvil];
    g.state.round.current_speaker = null;
    g.state.round.next_normal_speaker = assassin;

    await g.step();

    expect(prompts).toEqual(["assassination_decision"]);
    expect(g.state.status).toBe("completed");
    expect(g.state.phase).toBe("game_over");
    const attempt = g.state.event_log.find((e) => e.type === "assassination_attempt");
    expect(attempt?.type).toBe("assassination_attempt");
    if (attempt?.type === "assassination_attempt") {
      expect(attempt.assassin).toBe(assassin);
      expect(attempt.target).toBe(merlin);
      expect(attempt.target_was_merlin).toBe(true);
    }
  });

  it("keeps the Assassin's first council turn as discussion when another Assassin turn remains", async () => {
    const g = makeGame(93);
    const assassin = roleSeat(g, "Assassin");
    const otherEvil = g.state.seat_order.filter(
      (id) => g.state.players[id].alignment === "evil" && id !== assassin,
    );
    const prompts: PromptType[] = [];
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        prompts.push(input.prompt_type);
        const action = { action: "speak", target: null, speech: "我先听你们继续说。" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    g.state.status = "paused";
    g.state.phase = "assassination_discuss";
    g.state.round.normal_queue = [assassin, ...otherEvil, assassin];
    g.state.round.current_speaker = null;
    g.state.round.next_normal_speaker = assassin;

    await g.step();

    expect(prompts).toEqual(["full_speech"]);
    expect(g.state.status).toBe("paused");
    expect(g.state.phase).toBe("assassination_discuss");
    expect(g.state.event_log.some((e) => e.type === "assassination_attempt")).toBe(false);
    expect(g.state.round.normal_queue).toContain(assassin);
  });

  it("reveals all evil roles to every evil player during the assassination stage", async () => {
    const g = makeGame(94);
    const assassin = roleSeat(g, "Assassin");
    const morgana = roleSeat(g, "Morgana");
    const oberon = roleSeat(g, "Oberon");
    const merlin = roleSeat(g, "Merlin");
    const contexts: Array<{ prompt: PromptType; player: PlayerId; note?: string }> = [];

    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: PlayerId; context_note?: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        contexts.push({ prompt: input.prompt_type, player: input.player_id, note: input.context_note });
        const action =
          input.prompt_type === "assassination"
            ? { action: "assassinate", target: merlin, speech: "最终指认。" }
            : { action: "speak", target: null, speech: "我收到邪恶方身份表。" };
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    g.state.status = "paused";
    g.state.phase = "assassination_discuss";
    g.state.round.normal_queue = [oberon];
    g.state.round.current_speaker = null;
    g.state.round.next_normal_speaker = oberon;

    await g.step();

    const oberonContext = contexts.find((c) => c.player === oberon && c.prompt === "full_speech")?.note;
    expect(oberonContext).toContain(`${assassin}:刺客`);
    expect(oberonContext).toContain(`${morgana}:莫甘娜`);
    expect(oberonContext).toContain(`${oberon}:奥伯伦`);
    expect(oberonContext).toContain("奥伯伦现在知道刺客和莫甘娜是谁");

    g.state.status = "paused";
    g.state.phase = "assassination";
    await g.step();

    const assassinContext = contexts.find((c) => c.player === assassin && c.prompt === "assassination")?.note;
    expect(assassinContext).toContain(`${assassin}:刺客`);
    expect(assassinContext).toContain(`${morgana}:莫甘娜`);
    expect(assassinContext).toContain(`${oberon}:奥伯伦`);
  });

  it("stops default directed dialogue after two reply turns", async () => {
    expect(DIRECTED_DIALOGUE_MAX_EXCHANGES).toBe(2);
    const g = makeGame(102);
    const scripted: Record<string, PlayerAction> = {
      "B:full_speech": { action: "speak", target: "A", speech: "我回应你,也反问你。" },
      "A:full_speech": { action: "speak", target: "B", speech: "我再回应一次。" },
    };
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        const action = scripted[`${input.player_id}:${input.prompt_type}`] ?? ({ action: "pass" } as PlayerAction);
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    g.state.status = "paused";
    g.state.phase = "directed_reply";
    g.state.round.current_speaker = "A";
    g.state.round.next_normal_speaker = "C";
    g.state.round.normal_queue = ["C", "D", "E", "G", "A"];
    g.state.interrupts.directed_dialogue = {
      initiator: "A",
      target: "B",
      exchanges: 0,
      max_exchanges: DIRECTED_DIALOGUE_MAX_EXCHANGES,
      anchor_event_id: "evt_anchor",
      merged_with_normal: false,
    };

    await g.step();
    expect(g.state.phase).toBe("directed_reply");
    expect(g.state.interrupts.directed_dialogue?.target).toBe("A");
    expect(g.state.interrupts.directed_dialogue?.exchanges).toBe(1);

    await g.step();
    expect(g.state.phase).toBe("interrupt_collect");
    expect(g.state.interrupts.directed_dialogue).toBeNull();
    const replies = g.state.event_log.filter((e) => e.type === "public_speech" && e.source === "directed_reply");
    expect(replies).toHaveLength(2);
  });

  it("continues a directed reply when the responder targets a third player", async () => {
    const g = makeGame(101);
    const scripted: Record<string, PlayerAction> = {
      "B:full_speech": { action: "speak", target: "E", speech: "E 你也说一下。", memo: "转点E,看他如何解释。" },
      "B:leader_discussion": { action: "speak", target: "E", speech: "E 你也说一下。", memo: "转点E,看他如何解释。" },
      "E:full_speech": { action: "speak", target: null, speech: "我直接回应 B。", memo: "公开短答,暂不暴露完整判断。" },
      "E:leader_discussion": { action: "speak", target: null, speech: "我直接回应 B。", memo: "公开短答,暂不暴露完整判断。" },
    };
    (g as unknown as { adapter: { generateAction: (i: { prompt_type: PromptType; player_id: string }) => Promise<unknown> } }).adapter = {
      generateAction: async (input) => {
        const action = scripted[`${input.player_id}:${input.prompt_type}`] ?? ({ action: "pass" } as PlayerAction);
        return { raw_text: JSON.stringify(action), parsed_action: action, latency_ms: 0, attempts: 1 };
      },
    };

    g.state.status = "paused";
    g.state.phase = "directed_reply";
    g.state.round.current_speaker = "F";
    g.state.round.next_normal_speaker = "C";
    g.state.round.normal_queue = ["C", "D", "E", "G", "A"];
    g.state.interrupts.directed_dialogue = {
      initiator: "F",
      target: "B",
      exchanges: 1,
      max_exchanges: 3,
      anchor_event_id: "evt_anchor",
      merged_with_normal: false,
    };

    await g.step();
    const bSpeech = g.state.event_log.at(-1);
    expect(bSpeech?.type).toBe("public_speech");
    if (bSpeech?.type === "public_speech") {
      expect(bSpeech.player).toBe("B");
      expect(bSpeech.target).toBe("E");
      expect(bSpeech.source).toBe("directed_reply");
    }
    expect(g.state.phase).toBe("directed_reply");
    expect(g.state.interrupts.directed_dialogue?.initiator).toBe("B");
    expect(g.state.interrupts.directed_dialogue?.target).toBe("E");
    expect(g.state.players.B.private_view.notes).toContain("转点E,看他如何解释。");
    expect(g.state.event_log.some((e) => e.type === "private_memo" && e.player === "B" && e.memo === "转点E,看他如何解释。")).toBe(true);

    await g.step();
    const eSpeech = g.state.event_log.at(-1);
    expect(eSpeech?.type).toBe("public_speech");
    if (eSpeech?.type === "public_speech") {
      expect(eSpeech.player).toBe("E");
      expect(eSpeech.source).toBe("directed_reply");
    }
    expect(g.state.phase).toBe("interrupt_collect");
    expect(g.state.players.E.private_view.notes).toContain("公开短答,暂不暴露完整判断。");
    expect(g.state.event_log.some((e) => e.type === "private_memo" && e.player === "E" && e.memo === "公开短答,暂不暴露完整判断。")).toBe(true);
    expect(JSON.stringify(toPublicGameView(g.state))).not.toContain("公开短答,暂不暴露完整判断。");
  });
});
