/**
 * Mock model adapter. Produces deterministic, legal actions without any API
 * calls. Behavior is keyed by a hash of the call context so games are
 * reproducible yet varied. Used for offline play and all deterministic tests.
 */

import {
  QUEST_TABLE,
  SEAT_ORDER,
  playerLabel,
  roleLabel,
  type ModelCallInput,
  type ModelCallResult,
  type PlayerAction,
  type PlayerId,
} from "@avalon/shared";
import type { ModelAdapter } from "./adapter.js";

/** cyrb53-derived value in [0, 1). Deterministic for a given string. */
function hash01(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return (h % 1_000_000) / 1_000_000;
}

const GOOD_LINES = [
  "我倾向于相信那些支持过成功队伍的玩家。",
  "先别想太复杂,不过我会盯着大家怎么投票。",
  "在我表态之前,想多听听那些一直没怎么说话的座位。",
  "谁要是拼命想挤进每一支队伍,我就对谁有点警惕。",
];
const EVIL_LINES = [
  "这支队伍我看没问题,咱们就别拖了。",
  "我觉得大家想复杂了——队伍小而干净最好。",
  "我相信这个提案,一直否决只是白白浪费机会。",
  "我们应该多关注那些老是拖时间的玩家。",
];

export class MockAdapter implements ModelAdapter {
  readonly id = "mock";

  constructor(private readonly evilFailProb: number) {}

  async generateAction(input: ModelCallInput): Promise<ModelCallResult> {
    const action = this.decide(input);
    return {
      raw_text: JSON.stringify(action),
      parsed_action: action,
      latency_ms: 1,
      attempts: 1,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
  }

  private rand(input: ModelCallInput, salt: string): number {
    return hash01(
      `${input.player_id}|${input.prompt_type}|${input.public_view.public_event_log.length}|${input.public_view.quest_index}|${salt}`,
    );
  }

  private decide(input: ModelCallInput): PlayerAction {
    const view = input.private_view;
    switch (input.prompt_type) {
      case "interrupt_intent":
        // Mock players stay orderly and pass; the interrupt system is exercised
        // directly in tests and by real models.
        return { action: "pass" };

      case "full_speech": {
        const lines = view.alignment === "evil" ? EVIL_LINES : GOOD_LINES;
        const idx = Math.floor(this.rand(input, "speech") * lines.length);
        return { action: "speak", target: null, speech: lines[idx]! };
      }

      case "full_speech_optional": {
        // Round-1 discussion: about half the seats have nothing to add and pass,
        // the rest speak — so mock games both exercise and visibly demonstrate it.
        if (this.rand(input, "speech_optional") < 0.5) {
          return { action: "pass" };
        }
        const lines = view.alignment === "evil" ? EVIL_LINES : GOOD_LINES;
        const idx = Math.floor(this.rand(input, "speech") * lines.length);
        return { action: "speak", target: null, speech: lines[idx]! };
      }

      case "leader_discussion": {
        const size = QUEST_TABLE[input.public_view.quest_index]!.required_players;
        const leader = input.player_id;
        const others = SEAT_ORDER.filter((s) => s !== leader);
        const team: PlayerId[] = [leader, ...others].slice(0, size);
        if (this.rand(input, "leader_discussion") < 0.45) {
          return {
            action: "propose_team",
            team,
            speech: `我直接发 ${team.join("-")},先跑结果。`,
          };
        }
        return {
          action: "speak",
          target: null,
          speech: "我先不急着定车,大家可以先给队形意见。",
        };
      }

      case "assassination_decision": {
        const lines = view.alignment === "evil" ? EVIL_LINES : GOOD_LINES;
        const idx = Math.floor(this.rand(input, "assassin_discuss") * lines.length);
        return { action: "speak", target: null, speech: lines[idx]! };
      }

      case "leader_proposal": {
        const size = QUEST_TABLE[input.public_view.quest_index]!.required_players;
        const leader = input.player_id;
        const others = SEAT_ORDER.filter((s) => s !== leader);
        const team: PlayerId[] = [leader, ...others].slice(0, size);
        return {
          action: "propose_team",
          team,
          speech: `我先发车,带 ${team.join("-")}。`,
        };
      }

      case "vote": {
        const team = input.public_view.proposed_team ?? [];
        let approveChance = 0.72;
        if (view.alignment === "evil") {
          const teammateOn = (view.evil_team ?? []).some((id) => team.includes(id));
          approveChance = teammateOn ? 0.95 : 0.55;
        }
        const approve = this.rand(input, "vote") < approveChance;
        return { action: "vote", approve };
      }

      case "mission": {
        if (view.alignment === "good") return { action: "mission_card", card: "success" };
        const fail = this.rand(input, "mission") < this.evilFailProb;
        return { action: "mission_card", card: fail ? "fail" : "success" };
      }

      case "assassination": {
        const evil = new Set(view.evil_team ?? [input.player_id]);
        const goodSeats = SEAT_ORDER.filter((s) => !evil.has(s));
        const pool = goodSeats.length ? goodSeats : SEAT_ORDER.filter((s) => s !== input.player_id);
        const target = pool[Math.floor(this.rand(input, "assassin") * pool.length)]!;
        return {
          action: "assassinate",
          target,
          speech: `${playerLabel(target)} 好像知道得太多了。`,
        };
      }

      case "postgame_review": {
        const won = input.public_view.winner === view.alignment;
        const role = roleLabel(view.role);
        return {
          action: "speak",
          target: null,
          speech: won
            ? `原来我是${role},这局我们赢在关键轮没有散。下次我还可以把复盘点说得更具体一点。`
            : `原来我是${role},这局我有几处判断没跟上。下次我要更早抓任务和票型里的关键矛盾。`,
        };
      }

      default:
        return { action: "pass" };
    }
  }
}
