/**
 * Legal fallback actions. When a model errors, returns malformed output, or
 * proposes an illegal action after retries, the controller substitutes one of
 * these so the game always continues. Every fallback is guaranteed legal.
 */

import {
  SEAT_ORDER,
  playerLabel,
  type GameState,
  type GameEvent,
  type PlayerAction,
  type PlayerId,
  type PromptType,
} from "@avalon/shared";
import { requiredTeamSize } from "../game/rules.js";

/** A legal team for the current quest: leader + seat-order fill, avoiding teams
 * already rejected this quest when an alternative exists. */
function fallbackTeam(state: GameState, leader: PlayerId): PlayerId[] {
  const size = requiredTeamSize(state.round.quest_index);
  const others = SEAT_ORDER.filter((s) => s !== leader);
  const base: PlayerId[] = [leader, ...others].slice(0, size);

  // Try a couple of rotations to dodge a team that was just rejected.
  const rejected = state.round.proposed_team;
  const sameAsRejected = (team: PlayerId[]) =>
    rejected !== null &&
    rejected.length === team.length &&
    rejected.every((id) => team.includes(id));

  if (!sameAsRejected(base)) return base;
  for (let rot = 1; rot < others.length; rot++) {
    const rotated = [leader, ...others.slice(rot), ...others.slice(0, rot)].slice(0, size);
    if (!sameAsRejected(rotated)) return rotated;
  }
  return base;
}

/** Varied fallback speeches so a model that keeps failing doesn't read as an
 * identical 复读机. Rotated by how many speeches have happened. */
const FALLBACK_SPEECHES = [
  "我先保留判断,看投票。",
  "信息还少,先听后面。",
  "我暂时不下结论,看结果。",
  "这轮我先观望。",
  "先让车跑起来再说。",
];

function names(ids: PlayerId[]): string {
  return ids.length ? ids.map((id) => playerLabel(id)).join("、") : "无";
}

function lastEventOfType<T extends GameEvent["type"]>(
  state: GameState,
  type: T,
): Extract<GameEvent, { type: T }> | null {
  for (let i = state.event_log.length - 1; i >= 0; i--) {
    const event = state.event_log[i]!;
    if (event.type === type) return event as Extract<GameEvent, { type: T }>;
  }
  return null;
}

function leaderDiscussionFallbackSpeech(state: GameState): string {
  const mission = lastEventOfType(state, "mission_result");
  if (mission) {
    const team = names(mission.team);
    if (!mission.passed) {
      return (
        `先别急定车,先盘上一轮失败任务:车是${team},出了${mission.fail_count}张失败牌。` +
        "大家先说车内责任、车外赞反和票型信息,我听完再定车。"
      );
    }
    return (
      `先从上一轮成功车${team}和票型盘起,看哪些内白/外白被抬高,` +
      "有没有原车复跑或少量换人的必要,我听完再定车。"
    );
  }

  const vote = lastEventOfType(state, "vote_revealed");
  if (vote) {
    return (
      `先盘上一轮投票:赞成${names(vote.approvals)},反对${names(vote.rejections)}。` +
      "重点看内黑、外白和是否有人卡车,我听完再定车。"
    );
  }

  return "第一轮信息少,我先听一圈上车意愿和对队长自带的看法,再定车。";
}

export function fallbackAction(
  state: GameState,
  player: PlayerId,
  promptType: PromptType,
): PlayerAction {
  switch (promptType) {
    case "interrupt_intent":
      return { action: "pass" };

    case "full_speech": {
      const i = state.event_log.length % FALLBACK_SPEECHES.length;
      return { action: "speak", target: null, speech: FALLBACK_SPEECHES[i]! };
    }

    case "full_speech_optional":
      // Round-1 discussion with nothing to add: passing is the natural no-op.
      return { action: "pass" };

    case "leader_discussion":
      return {
        action: "speak",
        target: null,
        speech: leaderDiscussionFallbackSpeech(state),
      };

    case "assassination_decision": {
      const i = state.event_log.length % FALLBACK_SPEECHES.length;
      return { action: "speak", target: null, speech: FALLBACK_SPEECHES[i]! };
    }

    case "postgame_review": {
      const won = state.winner === state.players[player].alignment;
      return {
        action: "speak",
        target: null,
        speech: won
          ? "这局赢下来主要靠关键任务和票型咬住了,我自己还可以把判断说得更清楚。"
          : "这局我有几处判断和表达没做好,下次要更早复盘关键票型,别被局势带着走。",
      };
    }

    case "leader_proposal": {
      const team = fallbackTeam(state, player);
      return { action: "propose_team", team, speech: "我先发一个稳妥队伍。" };
    }

    case "vote":
      // Approve when uncertain: a failed/malformed vote call is a technical
      // failure, not a strategic reject. Defaulting to reject is invisible to
      // spectators, systematically favors evil (5 rejects in a quest = evil win)
      // and burns proposal attempts; approve is the safe, evil-neutral default
      // and matches the near-universal correct play on an early team.
      return { action: "vote", approve: true };

    case "mission":
      // Good must play success; evil defaults to success to stay hidden.
      return { action: "mission_card", card: "success" };

    case "assassination": {
      const evil = new Set(state.players[player].private_view.evil_team ?? [player]);
      const candidate =
        SEAT_ORDER.find((s) => !evil.has(s)) ??
        SEAT_ORDER.find((s) => s !== player) ??
        player;
      return {
        action: "assassinate",
        target: candidate,
        speech: "凭我对梅林最强的直觉,选他。",
      };
    }

    default:
      return { action: "pass" };
  }
}
