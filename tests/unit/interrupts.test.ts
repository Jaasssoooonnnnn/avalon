import { describe, expect, it } from "vitest";
import { defaultConfig, type GameState, type InterruptRequest, type PlayerId } from "@avalon/shared";
import { createInitialState } from "../../apps/server/src/game/state";
import {
  computeInterruptPlayerPriority,
  computeInterruptScore,
  isEligibleInterruptRequester,
  isInterruptRequestExpired,
  makeInterruptRequest,
  selectWinningInterrupt,
} from "../../apps/server/src/controller/interrupts";
import { IdGen } from "../../apps/server/src/utils/ids";
import { makeRng } from "../../apps/server/src/utils/random";

function discussionState(): GameState {
  const s = createInitialState("t", { ...defaultConfig(), seed: 3 }, new IdGen(), makeRng(3));
  s.phase = "interrupt_collect";
  s.round.leader = "G";
  s.round.current_speaker = "C"; // just spoke
  s.round.next_normal_speaker = "D"; // up next
  s.interrupts.phase_budget_remaining = 8;
  return s;
}

function req(player: PlayerId, arrival: number, overrides: Partial<InterruptRequest> = {}): InterruptRequest {
  return {
    request_id: `req_${player}_${arrival}`,
    player,
    target: null,
    speech: "x",
    anchor_event_id: "evt_x",
    arrival_seq: arrival,
    created_at_event_index: 0,
    expires_after_event_index: 10,
    score: 0,
    ...overrides,
  };
}

describe("interrupt eligibility", () => {
  it("the player who just spoke cannot interrupt", () => {
    expect(isEligibleInterruptRequester(discussionState(), "C")).toBe(false);
  });

  it("the next normal speaker cannot actively interrupt", () => {
    expect(isEligibleInterruptRequester(discussionState(), "D")).toBe(false);
  });

  it("other players are eligible", () => {
    expect(isEligibleInterruptRequester(discussionState(), "A")).toBe(true);
  });

  it("cooldown blocks interrupting", () => {
    const s = discussionState();
    s.talk_stats.A.cooldown_until_event_index = 3; // publicSpeechCount is 0
    expect(isEligibleInterruptRequester(s, "A")).toBe(false);
  });

  it("per-player phase cap blocks interrupting", () => {
    const s = discussionState();
    s.talk_stats.A.interrupts_in_phase = 2;
    expect(isEligibleInterruptRequester(s, "A")).toBe(false);
  });

  it("exhausted phase budget blocks everyone", () => {
    const s = discussionState();
    s.interrupts.phase_budget_remaining = 0;
    expect(isEligibleInterruptRequester(s, "A")).toBe(false);
  });
});

describe("interrupt expiry + scoring", () => {
  it("treats requests past their TTL as expired/illegal", () => {
    const s = discussionState();
    const expired = req("A", 1, { expires_after_event_index: -1 });
    expect(isInterruptRequestExpired(expired, s)).toBe(true);
    expect(computeInterruptScore(expired, s)).toBe(-100000);
  });

  it("scores an ineligible requester (current speaker) as illegal", () => {
    const s = discussionState();
    expect(computeInterruptScore(req("C", 1), s)).toBe(-100000);
  });

  it("drops player priority after they have already interrupted in this phase", () => {
    const s = discussionState();
    const before = computeInterruptPlayerPriority(s, "A");
    s.talk_stats.A.interrupts_in_phase = 1;
    expect(computeInterruptPlayerPriority(s, "A")).toBeLessThan(before);
  });
});

describe("winner selection (FIFO tie-break)", () => {
  it("breaks score ties by earliest arrival", () => {
    const s = discussionState();
    s.interrupts.queue = [req("A", 5), req("B", 2)]; // identical stats → equal score
    const winner = selectWinningInterrupt(s);
    expect(winner?.player).toBe("B"); // arrival 2 < 5
  });

  it("prefers the higher score regardless of arrival", () => {
    const s = discussionState();
    // B targets the last speaker C? no last speech; give A a leader-target bonus.
    s.interrupts.queue = [req("B", 1), req("A", 9, { target: "G" })]; // A targets leader (+6)
    const winner = selectWinningInterrupt(s);
    expect(winner?.player).toBe("A");
  });

  it("prefers player priority over request content bonuses", () => {
    const s = discussionState();
    s.talk_stats.A.interrupts_in_phase = 1;
    s.interrupts.queue = [req("A", 1, { target: "G" }), req("B", 9)];
    const winner = selectWinningInterrupt(s);
    expect(winner?.player).toBe("B");
  });

  it("returns null when no legal request remains", () => {
    const s = discussionState();
    s.interrupts.queue = [req("C", 1)]; // C just spoke → illegal
    expect(selectWinningInterrupt(s)).toBeNull();
  });
});

describe("makeInterruptRequest", () => {
  it("assigns increasing arrival sequence numbers", () => {
    const s = discussionState();
    const idgen = new IdGen();
    const r1 = makeInterruptRequest(s, idgen, "A", null, "hi", "evt_1");
    const r2 = makeInterruptRequest(s, idgen, "B", null, "hi", "evt_1");
    expect(r2.arrival_seq).toBeGreaterThan(r1.arrival_seq);
  });
});
