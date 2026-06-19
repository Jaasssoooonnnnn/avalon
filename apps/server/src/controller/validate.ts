/**
 * Game-legality validation. The adapter already guarantees the action *shape*
 * (via Zod); this layer enforces game rules: correct phase, leader-only
 * proposals, team size, no duplicate votes, mission membership, good-can't-fail,
 * assassin-only assassination, etc. Used by the controller and exercised by tests.
 */

import {
  type GameState,
  type PlayerAction,
  type PlayerId,
} from "@avalon/shared";
import { isValidTeam } from "../game/rules.js";
import { isEligibleInterruptRequester } from "./interrupts.js";

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const OK: ValidationResult = { ok: true };
function bad(reason: string): ValidationResult {
  return { ok: false, reason };
}

const SPEAKING_PHASES = new Set([
  "discussion",
  "normal_speech",
  "interrupt_speech",
  "directed_reply",
  "team_finalize",
  "assassination_discuss",
]);

const PROPOSAL_SPEAKING_PHASES = new Set([
  "discussion",
  "normal_speech",
  "interrupt_speech",
  "directed_reply",
]);

function isRealSeat(state: GameState, id: PlayerId): boolean {
  return Boolean(state.players[id]);
}

export function validateAction(
  state: GameState,
  player: PlayerId,
  action: PlayerAction,
): ValidationResult {
  if (!isRealSeat(state, player)) return bad(`unknown player ${player}`);

  switch (action.action) {
    case "pass":
      // No-op; always harmless.
      return OK;

    case "request_interrupt": {
      if (state.phase !== "interrupt_collect") {
        return bad("interrupt requests are only accepted during interrupt collection");
      }
      if (!isEligibleInterruptRequester(state, player)) {
        return bad("player is not eligible to interrupt right now");
      }
      if (action.target != null && !isRealSeat(state, action.target)) {
        return bad(`invalid interrupt target ${action.target}`);
      }
      return OK;
    }

    case "withdraw_interrupt": {
      const req = state.interrupts.queue.find((r) => r.request_id === action.request_id);
      if (!req) return bad(`no such interrupt request ${action.request_id}`);
      if (req.player !== player) return bad("cannot withdraw another player's interrupt");
      return OK;
    }

    case "speak": {
      if (!SPEAKING_PHASES.has(state.phase)) {
        return bad(`cannot speak during phase ${state.phase}`);
      }
      if (state.round.current_speaker !== player) {
        return bad("it is not this player's turn to speak");
      }
      if (action.target != null && !isRealSeat(state, action.target)) {
        return bad(`invalid speech target ${action.target}`);
      }
      return OK;
    }

    case "propose_team": {
      if (state.round.leader !== player) {
        return bad("only the current leader may propose a team");
      }
      if (state.phase !== "leader_proposal") {
        if (!PROPOSAL_SPEAKING_PHASES.has(state.phase)) {
          return bad(`teams can only be proposed during leader discussion (phase is ${state.phase})`);
        }
        if (state.round.current_speaker !== player) {
          return bad("leader can only propose while holding the floor");
        }
        if (state.round.proposed_team !== null) {
          return bad("a team has already been proposed for this attempt");
        }
      }
      if (!isValidTeam(action.team, state.round.quest_index, state)) {
        return bad(
          `invalid team: must be ${state.quests[state.round.quest_index]!.required_players} distinct valid players`,
        );
      }
      return OK;
    }

    case "vote": {
      if (state.phase !== "team_vote") {
        return bad(`votes are only accepted during team_vote (phase is ${state.phase})`);
      }
      if (state.votes[player] !== null && state.votes[player] !== undefined) {
        return bad("player has already voted");
      }
      return OK;
    }

    case "mission_card": {
      if (state.phase !== "mission_action") {
        return bad(`mission cards are only accepted during mission_action (phase is ${state.phase})`);
      }
      if (!state.mission.active || !state.mission.team.includes(player)) {
        return bad("player is not on the current mission team");
      }
      if (state.mission.cards[player] !== null && state.mission.cards[player] !== undefined) {
        return bad("player has already submitted a mission card");
      }
      if (state.players[player].alignment === "good" && action.card === "fail") {
        return bad("good players may not play a fail card");
      }
      return OK;
    }

    case "assassinate": {
      const duringFinalKill = state.phase === "assassination";
      const duringCouncilDecision =
        state.phase === "assassination_discuss" && state.round.current_speaker === player;
      if (!duringFinalKill && !duringCouncilDecision) {
        return bad(`assassination only allowed during assassination phase or assassin council decision (phase is ${state.phase})`);
      }
      if (state.players[player].role !== "Assassin") {
        return bad("only the Assassin may assassinate");
      }
      if (!isRealSeat(state, action.target)) {
        return bad(`invalid assassination target ${action.target}`);
      }
      if (action.target === player) {
        return bad("the Assassin cannot target themselves");
      }
      return OK;
    }

    default:
      return bad("unknown action");
  }
}
