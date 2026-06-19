import { describe, expect, it } from "vitest";
import { defaultConfig, type GameState, type PlayerId } from "@avalon/shared";
import { createInitialState } from "../../apps/server/src/game/state";
import { validateAction } from "../../apps/server/src/controller/validate";
import { validateActionShape, parseAction } from "../../apps/server/src/models/parse";
import { findForbiddenControlField } from "@avalon/shared";
import { IdGen } from "../../apps/server/src/utils/ids";
import { makeRng } from "../../apps/server/src/utils/random";

function freshState(seed = 5): GameState {
  const config = { ...defaultConfig(), seed };
  return createInitialState("t", config, new IdGen(), makeRng(seed));
}
const roleSeat = (s: GameState, role: string): PlayerId =>
  Object.values(s.players).find((p) => p.role === role)!.id;
const seatExcept = (s: GameState, ...exclude: PlayerId[]): PlayerId =>
  s.seat_order.find((id) => !exclude.includes(id))!;

describe("propose_team validation", () => {
  it("accepts a correct-size team from the leader", () => {
    const s = freshState();
    s.phase = "leader_proposal";
    const leader = s.round.leader;
    const other = seatExcept(s, leader);
    expect(validateAction(s, leader, { action: "propose_team", team: [leader, other] }).ok).toBe(true);
  });

  it("rejects a proposal from a non-leader", () => {
    const s = freshState();
    s.phase = "leader_proposal";
    const leader = s.round.leader;
    const notLeader = seatExcept(s, leader);
    const r = validateAction(s, notLeader, { action: "propose_team", team: [notLeader, leader] });
    expect(r.ok).toBe(false);
  });

  it("rejects the wrong team size", () => {
    const s = freshState();
    s.phase = "leader_proposal"; // quest 0 needs 2
    const leader = s.round.leader;
    const a = seatExcept(s, leader);
    const b = seatExcept(s, leader, a);
    expect(validateAction(s, leader, { action: "propose_team", team: [leader, a, b] }).ok).toBe(false);
  });

  it("rejects duplicate members", () => {
    const s = freshState();
    s.phase = "leader_proposal";
    const leader = s.round.leader;
    expect(validateAction(s, leader, { action: "propose_team", team: [leader, leader] }).ok).toBe(false);
  });

  it("rejects proposing in the wrong phase", () => {
    const s = freshState();
    s.phase = "team_vote";
    const leader = s.round.leader;
    const other = seatExcept(s, leader);
    expect(validateAction(s, leader, { action: "propose_team", team: [leader, other] }).ok).toBe(false);
  });

  it("allows the current leader to propose while holding the discussion floor", () => {
    const s = freshState();
    s.phase = "discussion";
    const leader = s.round.leader;
    const other = seatExcept(s, leader);
    s.round.current_speaker = leader;
    expect(validateAction(s, leader, { action: "propose_team", team: [leader, other] }).ok).toBe(true);
  });

  it("rejects discussion proposals from non-leaders or leaders without the floor", () => {
    const s = freshState();
    s.phase = "discussion";
    const leader = s.round.leader;
    const other = seatExcept(s, leader);
    s.round.current_speaker = other;
    expect(validateAction(s, other, { action: "propose_team", team: [leader, other] }).ok).toBe(false);
    expect(validateAction(s, leader, { action: "propose_team", team: [leader, other] }).ok).toBe(false);
  });

  it("rejects a second proposal in the same attempt during discussion", () => {
    const s = freshState();
    s.phase = "discussion";
    const leader = s.round.leader;
    const other = seatExcept(s, leader);
    s.round.current_speaker = leader;
    s.round.proposed_team = [leader, other];
    expect(validateAction(s, leader, { action: "propose_team", team: [leader, other] }).ok).toBe(false);
  });
});

describe("vote validation", () => {
  it("rejects duplicate votes", () => {
    const s = freshState();
    s.phase = "team_vote";
    expect(validateAction(s, "A", { action: "vote", approve: true }).ok).toBe(true);
    s.votes.A = true;
    expect(validateAction(s, "A", { action: "vote", approve: false }).ok).toBe(false);
  });

  it("rejects votes outside team_vote", () => {
    const s = freshState();
    s.phase = "leader_proposal";
    expect(validateAction(s, "A", { action: "vote", approve: true }).ok).toBe(false);
  });
});

describe("mission card validation", () => {
  function missionState() {
    const s = freshState(11);
    s.phase = "mission_action";
    s.mission.active = true;
    const good = Object.values(s.players).find((p) => p.alignment === "good")!.id;
    const evil = Object.values(s.players).find((p) => p.alignment === "evil")!.id;
    s.mission.team = [good, evil];
    s.mission.cards = { ...s.mission.cards, [good]: null, [evil]: null };
    return { s, good, evil };
  }

  it("rejects cards from players not on the team", () => {
    const { s, good, evil } = missionState();
    const off = seatExcept(s, good, evil);
    expect(validateAction(s, off, { action: "mission_card", card: "success" }).ok).toBe(false);
  });

  it("forbids good players from playing fail", () => {
    const { s, good } = missionState();
    expect(validateAction(s, good, { action: "mission_card", card: "fail" }).ok).toBe(false);
    expect(validateAction(s, good, { action: "mission_card", card: "success" }).ok).toBe(true);
  });

  it("allows evil players to play fail", () => {
    const { s, evil } = missionState();
    expect(validateAction(s, evil, { action: "mission_card", card: "fail" }).ok).toBe(true);
  });
});

describe("assassination validation", () => {
  it("only the Assassin may assassinate, not self", () => {
    const s = freshState(23);
    s.phase = "assassination";
    const assassin = roleSeat(s, "Assassin");
    const merlin = roleSeat(s, "Merlin");
    expect(validateAction(s, assassin, { action: "assassinate", target: merlin }).ok).toBe(true);
    expect(validateAction(s, assassin, { action: "assassinate", target: assassin }).ok).toBe(false);
    const notAssassin = roleSeat(s, "Merlin");
    expect(validateAction(s, notAssassin, { action: "assassinate", target: assassin }).ok).toBe(false);
  });

  it("allows the current Assassin to assassinate during council decision", () => {
    const s = freshState(24);
    s.phase = "assassination_discuss";
    const assassin = roleSeat(s, "Assassin");
    const merlin = roleSeat(s, "Merlin");
    s.round.current_speaker = assassin;
    expect(validateAction(s, assassin, { action: "assassinate", target: merlin }).ok).toBe(true);
    s.round.current_speaker = merlin;
    expect(validateAction(s, assassin, { action: "assassinate", target: merlin }).ok).toBe(false);
  });
});

describe("speak validation", () => {
  it("only the current speaker may speak", () => {
    const s = freshState();
    s.phase = "normal_speech";
    s.round.current_speaker = "C";
    expect(validateAction(s, "C", { action: "speak", speech: "hi" }).ok).toBe(true);
    expect(validateAction(s, "D", { action: "speak", speech: "hi" }).ok).toBe(false);
  });
});

describe("shape validation rejects control-plane fields", () => {
  it("rejects a model-emitted priority field", () => {
    expect(findForbiddenControlField({ action: "vote", approve: true, priority: 9 })).toBe("priority");
    const r = validateActionShape({ action: "vote", approve: true, priority: 9 }, "vote");
    expect(r.ok).toBe(false);
  });

  it("strips benign extra fields like reasoning", () => {
    const r = validateActionShape({ action: "vote", approve: true, reasoning: "because" }, "vote");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action).toEqual({ action: "vote", approve: true });
  });

  it("keeps memo as a legal private player note", () => {
    const r = validateActionShape({ action: "vote", approve: true, memo: "私下先记住这票" }, "vote");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action).toEqual({ action: "vote", approve: true, memo: "私下先记住这票" });
  });

  it("rejects an action not allowed for the prompt type", () => {
    const r = validateActionShape({ action: "vote", approve: true }, "mission");
    expect(r.ok).toBe(false);
  });

  it("allows speak or assassinate for the assassination decision prompt", () => {
    expect(validateActionShape({ action: "speak", target: null, speech: "再听一下" }, "assassination_decision").ok).toBe(true);
    expect(validateActionShape({ action: "assassinate", target: "A" }, "assassination_decision").ok).toBe(true);
    expect(validateActionShape({ action: "vote", approve: true }, "assassination_decision").ok).toBe(false);
  });

  it("parses JSON embedded in noisy text", () => {
    const r = parseAction('Sure! ```json\n{"action":"vote","approve":false}\n``` done', "vote");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action).toEqual({ action: "vote", approve: false });
  });
});
