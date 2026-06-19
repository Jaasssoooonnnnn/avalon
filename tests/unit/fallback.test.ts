import { describe, expect, it } from "vitest";
import { defaultConfig, type GameState } from "@avalon/shared";
import { fallbackAction } from "../../apps/server/src/controller/fallback";
import { createInitialState } from "../../apps/server/src/game/state";
import { IdGen } from "../../apps/server/src/utils/ids";
import { makeRng } from "../../apps/server/src/utils/random";

function freshState(): GameState {
  return createInitialState("fallback_test", defaultConfig(), new IdGen(), makeRng(1));
}

describe("fallbackAction", () => {
  it("uses a first-round leader discussion fallback instead of the old generic line", () => {
    const state = freshState();
    const action = fallbackAction(state, state.round.leader, "leader_discussion");

    expect(action.action).toBe("speak");
    if (action.action === "speak") {
      expect(action.speech).toContain("第一轮信息少");
      expect(action.speech).not.toBe("我先听一圈意见,最后再定车。");
    }
  });

  it("makes a new leader discuss the previous failed mission and vote texture", () => {
    const state = freshState();
    state.quests[0] = {
      ...state.quests[0]!,
      team: ["A", "B"],
      leader: "A",
      result: "fail",
      fail_count: 1,
    };
    state.event_log.push({
      type: "mission_result",
      event_id: "evt_failed_mission",
      timestamp: Date.now(),
      quest_index: 0,
      team: ["A", "B"],
      success_count: 1,
      fail_count: 1,
      passed: false,
    });

    const action = fallbackAction(state, state.round.leader, "leader_discussion");

    expect(action.action).toBe("speak");
    if (action.action === "speak") {
      expect(action.speech).toContain("上一轮失败任务");
      expect(action.speech).toContain("出了1张失败牌");
      expect(action.speech).toContain("车内责任");
      expect(action.speech).toContain("车外赞反");
    }
  });
});
