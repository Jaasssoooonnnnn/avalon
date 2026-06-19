/**
 * View projection — the hidden-information boundary.
 *
 *  - PublicGameView: what a No-Vision spectator (and what models) may see. NO
 *    roles, alignments, private views, pre-reveal votes, mission card ownership,
 *    interrupt internals, or raw model data.
 *  - GodView: the full authoritative state plus debug aids.
 *
 * If you add a new GameEvent type, decide explicitly whether it is public by
 * adding it to PUBLIC_EVENT_TYPES (default: hidden).
 */

import type {
  GameEvent,
  GameState,
  GodView,
  PlayerId,
  PrivatePlayerView,
  PublicEvent,
  PublicGameView,
  PublicPlayerInfo,
  PublicQuestInfo,
} from "@avalon/shared";

/** Event types that are safe to expose to No-Vision spectators. */
const PUBLIC_EVENT_TYPES: ReadonlySet<GameEvent["type"]> = new Set([
  "game_created",
  "phase_changed",
  "leader_changed",
  "team_proposed",
  "public_speech",
  "speech_passed",
  "interrupt_granted",
  "vote_revealed",
  "mission_result",
  "assassination_attempt",
  "game_over",
  "postgame_roles_revealed",
]);

export function isPublicEvent(e: GameEvent): e is PublicEvent {
  return PUBLIC_EVENT_TYPES.has(e.type);
}

export function toPublicEventLog(state: GameState): PublicEvent[] {
  return state.event_log.filter(isPublicEvent);
}

/** Most recent revealed vote per player (null until any reveal). */
function lastRevealedVotes(state: GameState): Record<PlayerId, boolean | null> {
  const out = {} as Record<PlayerId, boolean | null>;
  for (const id of state.seat_order) out[id] = null;
  for (let i = state.event_log.length - 1; i >= 0; i--) {
    const e = state.event_log[i]!;
    if (e.type === "vote_revealed") {
      for (const id of e.approvals) out[id] = true;
      for (const id of e.rejections) out[id] = false;
      break;
    }
  }
  return out;
}

export function consecutiveRejections(state: GameState): number {
  // proposal_attempt is the 1-based index of the current proposal; the number of
  // rejected proposals so far this quest is one less.
  return Math.max(0, state.round.proposal_attempt - 1);
}

function toPublicPlayerInfo(
  state: GameState,
  id: PlayerId,
  revealedVotes: Record<PlayerId, boolean | null>,
): PublicPlayerInfo {
  const p = state.players[id];
  const round = state.round;
  const dd = state.interrupts.directed_dialogue;
  const hasPendingInterrupt = state.interrupts.queue.some((r) => r.player === id);
  const cooldownUntil = state.talk_stats[id].cooldown_until_event_index;
  return {
    id,
    display_name: p.display_name,
    model: p.model,
    status: p.status,
    is_leader: round.leader === id,
    is_current_speaker: round.current_speaker === id,
    is_on_proposed_team: round.proposed_team?.includes(id) ?? false,
    is_targeted: dd?.target === id,
    has_pending_interrupt: hasPendingInterrupt,
    in_cooldown: cooldownUntil !== null,
    last_vote: revealedVotes[id] ?? null,
  };
}

function toPublicQuestInfo(state: GameState): PublicQuestInfo[] {
  return state.quests.map((q) => ({
    index: q.index,
    required_players: q.required_players,
    fail_cards_required: q.fail_cards_required,
    result: q.result,
    // fail_count and team are only public once the mission has been resolved.
    fail_count: q.result === null ? null : q.fail_count,
    team: q.result === null ? null : q.team,
    leader: q.leader,
  }));
}

function revealedIdentities(state: GameState): PublicGameView["revealed_identities"] {
  for (let i = state.event_log.length - 1; i >= 0; i--) {
    const e = state.event_log[i]!;
    if (e.type === "postgame_roles_revealed") return e.identities;
  }
  return null;
}

function postgameReviewState(state: GameState): PublicGameView["postgame_review"] {
  const review =
    state.postgame_review ??
    ({
      status: "not_started",
      next_index: 0,
      completed_players: [],
    } as GameState["postgame_review"]);
  const done = review.status === "completed" || review.next_index >= state.seat_order.length;
  return {
    status: done ? "completed" : review.status,
    next_player: done ? null : state.seat_order[review.next_index] ?? null,
    completed_players: review.completed_players.slice(),
  };
}

export function toPublicGameView(state: GameState): PublicGameView {
  const revealed = lastRevealedVotes(state);
  return {
    game_id: state.game_id,
    status: state.status,
    phase: state.phase,
    quest_index: state.round.quest_index,
    leader: state.round.leader,
    current_speaker: state.round.current_speaker,
    next_normal_speaker: state.round.next_normal_speaker,
    proposed_team: state.round.proposed_team,
    proposal_attempt: state.round.proposal_attempt,
    consecutive_rejections: consecutiveRejections(state),
    players: state.seat_order.map((id) => toPublicPlayerInfo(state, id, revealed)),
    seat_order: state.seat_order.slice(),
    quest_history: toPublicQuestInfo(state),
    public_event_log: toPublicEventLog(state),
    pending_interrupts: state.interrupts.queue.length,
    // NOTE: the human's private view (role + secret) is intentionally NOT here —
    // PublicGameView feeds No-Vision spectators AND every model's adapter input.
    // The human player fetches their own view via GET /api/games/:id/human-view.
    human_seat: state.config.human_seat,
    pending_human: state.pending_human,
    winner: state.winner,
    game_over_reason: state.game_over_reason,
    postgame_review: postgameReviewState(state),
    revealed_identities: revealedIdentities(state),
  };
}

export function getPrivateView(state: GameState, id: PlayerId): PrivatePlayerView {
  return state.players[id].private_view;
}

export function toGodView(state: GameState): GodView {
  const interrupt_scores: Record<string, number> = {};
  for (const req of state.interrupts.queue) {
    interrupt_scores[req.request_id] = req.score;
  }
  return {
    state,
    public_view: toPublicGameView(state),
    interrupt_scores,
  };
}
