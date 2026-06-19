/**
 * Initial game state construction: model→seat assignment (with optional shuffle),
 * randomized role dealing, first-leader selection, and the opening events
 * (game_created + god-only role_assigned).
 */

import {
  MAX_INTERRUPT_SPEECHES_PER_PHASE,
  SEAT_ORDER,
  seatDisplayName,
  type GameConfig,
  type GameState,
  type ModelName,
  type PlayerId,
  type PlayerState,
  type PlayerTalkStats,
} from "@avalon/shared";
import type { IdGen } from "../utils/ids.js";
import { pickOne, shuffle, type Rng } from "../utils/random.js";
import { stampEvent } from "./events.js";
import { buildInitialQuests } from "./rules.js";
import { assignRoles, buildPrivateView } from "./roles.js";

function zeroTalkStats(): PlayerTalkStats {
  return {
    normal_speeches_in_phase: 0,
    interrupts_in_phase: 0,
    interrupts_in_round: 0,
    total_interrupts: 0,
    last_spoke_event_index: null,
    cooldown_until_event_index: null,
  };
}

/** Map each seat to a model, optionally shuffling the configured assignment. */
function effectiveSeatModels(
  config: GameConfig,
  rng: Rng,
): Record<PlayerId, ModelName> {
  const models = SEAT_ORDER.map((s) => config.seats[s]);
  const assigned = config.randomize_seats ? shuffle(models, rng) : models;
  const out = {} as Record<PlayerId, ModelName>;
  SEAT_ORDER.forEach((s, i) => {
    out[s] = assigned[i]!;
  });
  return out;
}

export function createInitialState(
  gameId: string,
  config: GameConfig,
  idgen: IdGen,
  rng: Rng,
): GameState {
  const seatModels = effectiveSeatModels(config, rng);
  const roles = assignRoles(rng);
  const firstLeader = pickOne(SEAT_ORDER, rng);

  const players = {} as Record<PlayerId, PlayerState>;
  const votes = {} as Record<PlayerId, boolean | null>;
  const talkStats = {} as Record<PlayerId, PlayerTalkStats>;
  const missionCards = {} as Record<PlayerId, "success" | "fail" | null>;

  for (const id of SEAT_ORDER) {
    const model = seatModels[id];
    const { role, alignment } = roles[id];
    players[id] = {
      id,
      display_name: seatDisplayName(id),
      model,
      role,
      alignment,
      status: "idle",
      private_view: buildPrivateView(id, model, roles, rng),
    };
    votes[id] = null;
    talkStats[id] = zeroTalkStats();
    missionCards[id] = null;
  }

  const now = Date.now();
  const state: GameState = {
    game_id: gameId,
    status: "not_started",
    created_at: now,
    players,
    seat_order: SEAT_ORDER.slice(),
    phase: "setup",
    round: {
      quest_index: 0,
      leader: firstLeader,
      proposal_attempt: 1,
      proposed_team: null,
      normal_speech_index: 0,
      current_speaker: null,
      next_normal_speaker: null,
      normal_queue: [],
    },
    quests: buildInitialQuests(),
    votes,
    mission: { active: false, team: [], cards: missionCards },
    interrupts: {
      queue: [],
      phase_budget_remaining: MAX_INTERRUPT_SPEECHES_PER_PHASE,
      directed_dialogue: null,
      granted: null,
      arrival_counter: 0,
      human_request: null,
    },
    talk_stats: talkStats,
    event_log: [],
    config,
    pending_human: null,
    winner: null,
    game_over_reason: null,
    postgame_review: {
      status: "not_started",
      next_index: 0,
      completed_players: [],
    },
    last_model_calls: [],
  };

  // Opening events.
  state.event_log.push(stampEvent(idgen, { type: "game_created" }));
  for (const id of SEAT_ORDER) {
    state.event_log.push(
      stampEvent(idgen, {
        type: "role_assigned",
        player: id,
        role: players[id].role,
        alignment: players[id].alignment,
        visibility: "god_only",
      }),
    );
  }
  state.event_log.push(
    stampEvent(idgen, { type: "leader_changed", leader: firstLeader }),
  );

  return state;
}
