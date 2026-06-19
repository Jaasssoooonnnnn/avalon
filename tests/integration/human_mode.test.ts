import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  type GameConfig,
  type GameState,
  type InterruptRequest,
  type PlayerAction,
  type PlayerId,
  type PromptType,
} from "@avalon/shared";
import { GameController } from "../../apps/server/src/controller/controller";
import { createInitialState } from "../../apps/server/src/game/state";
import { computeInterruptScore, selectWinningInterrupt } from "../../apps/server/src/controller/interrupts";
import { IdGen } from "../../apps/server/src/utils/ids";
import { makeRng } from "../../apps/server/src/utils/random";
import type { ServerConfig } from "../../apps/server/src/config";

const server: ServerConfig = {
  host: "127.0.0.1", port: 0, webOrigin: true,
  gateway: { baseUrl: "", apiKey: "" },
  forceMock: true, modelTimeoutMs: 1000, persist: false, dataDir: "/tmp/none", reasoningEffort: "medium",
};

function req(player: PlayerId, arrival: number): InterruptRequest {
  return {
    request_id: `req_${player}`, player, target: null, speech: "x",
    anchor_event_id: "e", arrival_seq: arrival, created_at_event_index: 0,
    expires_after_event_index: 10, score: 0,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function roleSeat(c: GameController, role: string): PlayerId {
  const seat = c.state.seat_order.find((id) => c.state.players[id].role === role);
  if (!seat) throw new Error(`missing role ${role}`);
  return seat;
}

function humanAssassinController(id: string): GameController {
  const c = new GameController(
    id,
    { ...defaultConfig(), mock: true, seed: 9, human_seat: "A" },
    server,
  );
  expect(c.state.players.A.role).toBe("Assassin");
  return c;
}

describe("human player: top interrupt priority", () => {
  it("scores the human's interrupt above any AI and always wins selection", () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 3, human_seat: "A" };
    const s: GameState = createInitialState("t", config, new IdGen(), makeRng(3));
    s.phase = "interrupt_collect";
    s.round.current_speaker = "C";
    s.round.next_normal_speaker = "D";
    s.interrupts.phase_budget_remaining = 8;

    const human = req("A", 5);
    const ai = req("B", 1); // arrives earlier, but the human must still win
    expect(computeInterruptScore(human, s)).toBe(1_000_000);
    expect(computeInterruptScore(ai, s)).toBeLessThan(1_000_000);

    s.interrupts.queue = [ai, human];
    expect(selectWinningInterrupt(s)?.player).toBe("A");
  });

  it("lets a human grab the floor before typing, then waits for their speech", async () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 3, human_seat: "A" };
    const c = new GameController("empty-grab", config, server);
    c.state.status = "running";
    c.state.phase = "interrupt_collect";
    c.state.round.current_speaker = "C";
    c.state.round.next_normal_speaker = "D";
    c.state.round.normal_queue = ["D", "E", "F"];
    c.state.interrupts.phase_budget_remaining = 8;

    expect(c.submitHumanAction({ action: "request_interrupt" }).ok).toBe(true);
    expect(c.state.interrupts.human_request).toEqual({ target: null, speech: "" });

    await c.step();
    expect(c.state.phase).toBe("interrupt_speech");
    expect(c.state.interrupts.granted?.player).toBe("A");

    const waiting = c.step();
    await waitFor(
      () => c.state.pending_human?.player === "A" && c.state.pending_human.prompt_type === "full_speech",
      "human interrupt speech prompt",
    );
    expect(c.submitHumanAction({ action: "speak", target: null, speech: "我先抢断,再补充观点。" }).ok).toBe(true);
    await waiting;

    expect(c.state.event_log.some((e) => e.type === "public_speech" && e.player === "A")).toBe(true);
  });
});

describe("human player: turn gating", () => {
  it("pauses for human input and runs to completion once answered", async () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 3, human_seat: "A" };
    const c = new GameController("h", config, server);
    const act = (pt: PromptType): PlayerAction => {
      const size = c.state.quests[c.state.round.quest_index]!.required_players;
      if (pt === "vote") return { action: "vote", approve: true };
      if (pt === "mission") return { action: "mission_card", card: "success" };
      if (pt === "full_speech") return { action: "speak", target: null, speech: "我发言" };
      if (pt === "leader_discussion") return { action: "speak", target: null, speech: "我先听意见" };
      if (pt === "leader_proposal")
        return { action: "propose_team", team: (["A", "B", "C", "D"].slice(0, size)) as PlayerId[], speech: "发车" };
      if (pt === "assassination") return { action: "assassinate", target: "B", speech: "猜B" };
      return { action: "pass" };
    };

    const done = c.runToCompletion(5000);
    let served = 0;
    for (let i = 0; i < 4000 && c.state.status !== "completed"; i++) {
      const ph = c.state.pending_human;
      if (ph?.player === "A") {
        expect(c.submitHumanAction(act(ph.prompt_type)).ok).toBe(true);
        served += 1;
      }
      await sleep(3);
    }
    await done;

    expect(c.state.status).toBe("completed");
    expect(served).toBeGreaterThan(0); // the game genuinely waited for the human
  });

  it("rejects a human action for a seat with no human, and only the human seat is gated", () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 1 }; // all-AI
    const c = new GameController("ai", config, server);
    expect(c.submitHumanAction({ action: "vote", approve: true }).ok).toBe(false);
  });

  it("notifies clients immediately after a pending human action is accepted", async () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 3, human_seat: "A" };
    const c = new GameController("human-clear-broadcast", config, server);
    c.state.status = "running";
    c.state.phase = "team_vote";

    const step = c.step();
    await waitFor(
      () => c.state.pending_human?.player === "A" && c.state.pending_human.prompt_type === "vote",
      "human vote prompt",
    );

    let sawClearedPending = false;
    const off = c.onChange(() => {
      if (c.state.pending_human === null) sawClearedPending = true;
    });

    expect(c.submitHumanAction({ action: "vote", approve: true }).ok).toBe(true);
    off();
    await step;

    expect(sawClearedPending).toBe(true);
  });

  it("clears a stale restored human prompt instead of accepting an impossible action", () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 3, human_seat: "A" };
    const c = new GameController("stale-human-prompt", config, server);
    c.state.status = "paused";
    c.state.phase = "discussion";
    c.state.round.current_speaker = "A";
    c.state.pending_human = {
      player: "A",
      prompt_type: "full_speech",
      legal_actions: ["speak"],
    };

    const res = c.submitHumanAction({ action: "speak", target: null, speech: "我发言" });

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("操作提示已经失效");
    expect(c.state.pending_human).toBeNull();
  });
});

describe("human player: immediate assassination", () => {
  it("lets a human Assassin assassinate before start and during ordinary phases", () => {
    const phases = [null, "discussion", "team_vote", "mission_action"] as const;
    for (const phase of phases) {
      const c = humanAssassinController(`kill-${phase ?? "not-started"}`);
      if (phase) {
        c.state.status = "running";
        c.state.phase = phase;
      }
      const merlin = roleSeat(c, "Merlin");

      expect(c.submitHumanAction({ action: "assassinate", target: merlin, speech: "我现在指认。" }).ok).toBe(true);
      expect(c.state.status).toBe("completed");
      expect(c.state.phase).toBe("game_over");
      expect(c.state.winner).toBe("evil");
      expect(c.state.event_log.some((e) => e.type === "assassination_attempt" && e.assassin === "A")).toBe(true);
    }
  });

  it("uses the early-miss result text before good has completed three quests", () => {
    const c = humanAssassinController("early-miss");
    const merlin = roleSeat(c, "Merlin");
    const target = c.state.seat_order.find((id) => id !== "A" && id !== merlin)!;

    expect(c.submitHumanAction({ action: "assassinate", target }).ok).toBe(true);
    expect(c.state.winner).toBe("good");
    expect(c.state.game_over_reason).toBe("刺客错指,正义方获胜。");
  });

  it("rejects non-Assassins, self targets, and already-completed games", () => {
    const baseline = humanAssassinController("baseline");
    const nonAssassin = baseline.state.seat_order.find((id) => baseline.state.players[id].role !== "Assassin")!;
    const c = new GameController(
      "non-assassin",
      { ...defaultConfig(), mock: true, seed: 9, human_seat: nonAssassin },
      server,
    );
    const merlin = roleSeat(c, "Merlin");
    expect(c.submitHumanAction({ action: "assassinate", target: merlin }).ok).toBe(false);

    const assassin = humanAssassinController("self-target");
    expect(assassin.submitHumanAction({ action: "assassinate", target: "A" }).ok).toBe(false);

    const completed = humanAssassinController("completed");
    expect(completed.submitHumanAction({ action: "assassinate", target: roleSeat(completed, "Merlin") }).ok).toBe(true);
    expect(completed.submitHumanAction({ action: "assassinate", target: roleSeat(completed, "Merlin") }).ok).toBe(false);
  });

  it("unblocks pending human prompts and prevents the old phase from committing after assassination", async () => {
    const cases = [
      {
        name: "speech",
        setup: (c: GameController) => {
          c.state.status = "running";
          c.state.phase = "discussion";
          c.state.round.normal_queue = ["A", "B"];
          c.state.round.current_speaker = null;
          c.state.round.next_normal_speaker = "A";
        },
        forbidden: "public_speech",
      },
      {
        name: "vote",
        setup: (c: GameController) => {
          c.state.status = "running";
          c.state.phase = "team_vote";
        },
        forbidden: "vote_cast",
      },
      {
        name: "mission",
        setup: (c: GameController) => {
          c.state.status = "running";
          c.state.phase = "mission_action";
          c.state.mission.active = true;
          c.state.mission.team = ["A", "B"];
          c.state.mission.cards.A = null;
          c.state.mission.cards.B = null;
        },
        forbidden: "mission_card_submitted",
      },
    ] as const;

    for (const tc of cases) {
      const c = humanAssassinController(`pending-${tc.name}`);
      tc.setup(c);
      const step = c.step();
      await waitFor(() => c.state.pending_human?.player === "A", `${tc.name} human prompt`);

      expect(c.submitHumanAction({ action: "assassinate", target: roleSeat(c, "Merlin") }).ok).toBe(true);
      await step;

      expect(c.state.status).toBe("completed");
      expect(c.state.pending_human).toBeNull();
      expect(c.state.event_log.some((e) => e.type === tc.forbidden)).toBe(false);
    }
  });
});

describe("human player: post-game review", () => {
  it("lets the human skip their post-game review turn and then continues the AI reviews", async () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 3, human_seat: "A" };
    const c = new GameController("human-postgame-review", config, server);
    c.state.status = "completed";
    c.state.phase = "game_over";
    c.state.winner = "good";
    c.state.game_over_reason = "测试结束。";

    expect(c.startPostgameReview().ok).toBe(true);
    await waitFor(
      () => c.state.pending_human?.player === "A" && c.state.pending_human.prompt_type === "postgame_review",
      "human postgame review prompt",
    );
    expect(c.state.postgame_review.status).toBe("waiting_human");

    const skip = c.submitHumanAction({
      action: "speak",
      target: null,
      speech: "我这轮先跳过复盘。",
    });
    expect(skip.ok).toBe(true);

    await waitFor(
      () => c.state.postgame_review.status === "completed",
      "postgame review completion after human skip",
    );

    expect(c.state.status).toBe("completed");
    expect(c.state.phase).toBe("game_over");
    expect(c.state.pending_human).toBeNull();

    const revealEvents = c.state.event_log.filter((e) => e.type === "postgame_roles_revealed");
    expect(revealEvents).toHaveLength(1);
    const reviewSpeeches = c.state.event_log.filter(
      (e) => e.type === "public_speech" && e.source === "postgame_review",
    );
    expect(reviewSpeeches).toHaveLength(c.state.seat_order.length);
    expect(
      reviewSpeeches.some(
        (e) => e.type === "public_speech" && e.player === "A" && e.speech.includes("跳过复盘"),
      ),
    ).toBe(true);
  });
});
