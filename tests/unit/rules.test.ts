import { describe, expect, it } from "vitest";
import {
  QUEST_TABLE,
  QUESTS_TO_WIN,
  MAX_PROPOSAL_ATTEMPTS,
  type PlayerId,
  type QuestState,
} from "@avalon/shared";
import {
  buildInitialQuests,
  countFailedQuests,
  countSuccessfulQuests,
  evilReachedQuestGoal,
  failCardsRequired,
  goodReachedQuestGoal,
  nextLeader,
  rejectionsExhausted,
  requiredTeamSize,
  resolveMission,
  tallyVotes,
} from "../../apps/server/src/game/rules";

describe("7-player quest table", () => {
  it("has the standard sizes and fail thresholds", () => {
    expect(QUEST_TABLE.map((q) => q.required_players)).toEqual([2, 3, 3, 4, 4]);
    expect(QUEST_TABLE.map((q) => q.fail_cards_required)).toEqual([1, 1, 1, 2, 1]);
  });

  it("requires 2 fail cards on quest 4", () => {
    expect(failCardsRequired(3)).toBe(2);
    expect(requiredTeamSize(3)).toBe(4);
  });
});

describe("mission resolution", () => {
  it("quest 4 passes with a single fail (needs 2)", () => {
    const r = resolveMission(["success", "fail", "success", "success"], failCardsRequired(3));
    expect(r.fail_count).toBe(1);
    expect(r.passed).toBe(true);
  });

  it("quest 4 fails with two fails", () => {
    const r = resolveMission(["fail", "fail", "success", "success"], failCardsRequired(3));
    expect(r.fail_count).toBe(2);
    expect(r.passed).toBe(false);
  });

  it("quest 5 fails with one fail", () => {
    const r = resolveMission(["success", "fail", "success", "success"], failCardsRequired(4));
    expect(r.passed).toBe(false);
  });

  it("all-success always passes", () => {
    expect(resolveMission(["success", "success"], 1).passed).toBe(true);
  });
});

describe("vote tally (strict majority of 7)", () => {
  it("approves on 4-3", () => {
    const votes: Record<PlayerId, boolean | null> = {
      A: true, B: true, C: true, D: true, E: false, F: false, G: false,
    };
    const t = tallyVotes(votes);
    expect(t.passed).toBe(true);
    expect(t.approvals).toHaveLength(4);
    expect(t.rejections).toHaveLength(3);
  });

  it("rejects on 3-4", () => {
    const votes: Record<PlayerId, boolean | null> = {
      A: true, B: true, C: true, D: false, E: false, F: false, G: false,
    };
    expect(tallyVotes(votes).passed).toBe(false);
  });
});

describe("win goals", () => {
  const q = (results: ("success" | "fail" | null)[]): QuestState[] =>
    buildInitialQuests().map((quest, i) => ({ ...quest, result: results[i] ?? null }));

  it("good reaches goal at 3 successes", () => {
    expect(goodReachedQuestGoal(q(["success", "success", "success"]))).toBe(true);
    expect(goodReachedQuestGoal(q(["success", "success", "fail"]))).toBe(false);
    expect(QUESTS_TO_WIN).toBe(3);
  });

  it("evil reaches goal at 3 fails", () => {
    expect(evilReachedQuestGoal(q(["fail", "fail", "fail"]))).toBe(true);
    expect(countFailedQuests(q(["fail", "fail", null]))).toBe(2);
    expect(countSuccessfulQuests(q(["success", "fail", "success"]))).toBe(2);
  });
});

describe("rejection limit + leader rotation", () => {
  it("evil wins after the 5th rejection in a quest", () => {
    expect(rejectionsExhausted(MAX_PROPOSAL_ATTEMPTS)).toBe(true);
    expect(rejectionsExhausted(4)).toBe(false);
    expect(MAX_PROPOSAL_ATTEMPTS).toBe(5);
  });

  it("rotates leadership clockwise by seat order", () => {
    const order: PlayerId[] = ["A", "B", "C", "D", "E", "F", "G"];
    expect(nextLeader("A", order)).toBe("B");
    expect(nextLeader("G", order)).toBe("A");
  });
});
