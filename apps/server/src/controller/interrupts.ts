/**
 * Interrupt eligibility, priority scoring, and selection. Pure functions over
 * GameState — the controller owns the orchestration and side effects.
 *
 * The interrupt "clock" is measured in public-speech events (see
 * publicSpeechCount), matching the spec's "expires after 2 public speech events"
 * and "cannot interrupt for the next 2 public speech events" rules.
 */

import {
  INTERRUPT_COOLDOWN_EVENTS,
  INTERRUPT_REQUEST_TTL_SPEECHES,
  MAX_INTERRUPTS_PER_PLAYER_PER_PHASE,
  type GameState,
  type InterruptRequest,
  type PlayerId,
} from "@avalon/shared";
import type { IdGen } from "../utils/ids.js";
import { getLastPublicSpeechEvent, publicSpeechCount } from "../game/events.js";

/** Is this player allowed to ACTIVELY request an interrupt right now? */
export function isEligibleInterruptRequester(
  state: GameState,
  player: PlayerId,
): boolean {
  const round = state.round;
  // The player who just spoke / is speaking may not immediately interrupt.
  if (round.current_speaker === player) return false;
  // The next normal speaker will get their turn anyway.
  if (round.next_normal_speaker === player) return false;
  // Phase interrupt budget exhausted.
  if (state.interrupts.phase_budget_remaining <= 0) return false;

  const stats = state.talk_stats[player];
  // Per-player per-phase cap.
  if (stats.interrupts_in_phase >= MAX_INTERRUPTS_PER_PLAYER_PER_PHASE) return false;
  // Event-based cooldown after a recent interrupt speech.
  if (
    stats.cooldown_until_event_index !== null &&
    publicSpeechCount(state) < stats.cooldown_until_event_index
  ) {
    return false;
  }
  return true;
}

export function isInterruptRequestExpired(
  req: InterruptRequest,
  state: GameState,
): boolean {
  return publicSpeechCount(state) > req.expires_after_event_index;
}

export function isLegalInterruptRequest(
  req: InterruptRequest,
  state: GameState,
): boolean {
  if (isInterruptRequestExpired(req, state)) return false;
  return isEligibleInterruptRequester(state, req.player);
}

/**
 * Internal priority score. Models never produce this — the controller computes
 * it. Higher is better; illegal/expired requests score -100000.
 */
export function computeInterruptScore(
  req: InterruptRequest,
  state: GameState,
): number {
  if (!isLegalInterruptRequest(req, state)) return -100000;

  const base = computeInterruptPlayerPriority(state, req.player);
  if (base <= -100000) return -100000;
  if (req.player === state.config.human_seat) return base;

  let score = base;
  // Natural target: responding to the person who just spoke.
  const lastSpeech = getLastPublicSpeechEvent(state);
  if (lastSpeech && req.target === lastSpeech.player) score += 10;
  // Targeting the current leader is often relevant.
  if (req.target === state.round.leader) score += 6;

  return score;
}

/**
 * Player-only interrupt priority. This deliberately ignores the request's
 * target/speech so early-stop decisions are based on who should get the floor,
 * not on content that slower callers have not produced yet.
 */
export function computeInterruptPlayerPriority(
  state: GameState,
  player: PlayerId,
): number {
  if (!isEligibleInterruptRequester(state, player)) return -100000;

  // The human player always wins the floor.
  if (player === state.config.human_seat) return 1_000_000;

  let score = 0;
  const stats = state.talk_stats[player];

  // Prefer players who have interrupted less in this phase.
  score += Math.max(0, 3 - stats.interrupts_in_phase) * 10;
  // Prefer players who have not yet spoken much.
  if (stats.normal_speeches_in_phase === 0) score += 8;
  // Penalize frequent interrupters.
  score -= stats.interrupts_in_phase * 15;
  score -= stats.interrupts_in_round * 8;
  score -= stats.total_interrupts * 2;
  return score;
}

/** Build a fresh interrupt request, assigning arrival order + TTL/cooldown clocks. */
export function makeInterruptRequest(
  state: GameState,
  idgen: IdGen,
  player: PlayerId,
  target: PlayerId | null | undefined,
  speech: string | undefined,
  anchorEventId: string,
): InterruptRequest {
  const now = publicSpeechCount(state);
  const arrival = state.interrupts.arrival_counter;
  state.interrupts.arrival_counter += 1;
  const req: InterruptRequest = {
    request_id: idgen.next("req"),
    player,
    target: target ?? null,
    speech: speech ?? "",
    anchor_event_id: anchorEventId,
    arrival_seq: arrival,
    created_at_event_index: now,
    expires_after_event_index: now + INTERRUPT_REQUEST_TTL_SPEECHES,
    score: 0,
  };
  req.score = computeInterruptScore(req, state);
  return req;
}

/**
 * Recompute scores for every queued request (in place) and return the winner:
 * highest score, ties broken by earliest arrival (FIFO). Returns null if no
 * legal request remains.
 */
export function selectWinningInterrupt(state: GameState): InterruptRequest | null {
  const queue = state.interrupts.queue;
  for (const req of queue) req.score = computeInterruptScore(req, state);

  const legal = queue.filter((r) => r.score > -100000);
  if (legal.length === 0) return null;

  const sorted = legal.slice().sort((a, b) => {
    const priorityDiff =
      computeInterruptPlayerPriority(state, b.player) -
      computeInterruptPlayerPriority(state, a.player);
    if (priorityDiff !== 0) return priorityDiff;
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.arrival_seq - b.arrival_seq;
  });
  return sorted[0]!;
}

/** The cooldown clock value to set after a player delivers an interrupt speech. */
export function cooldownTargetAfterInterrupt(state: GameState): number {
  return publicSpeechCount(state) + INTERRUPT_COOLDOWN_EVENTS;
}

/** Drop expired requests from the queue (called as the clock advances). */
export function pruneExpiredInterrupts(state: GameState): void {
  state.interrupts.queue = state.interrupts.queue.filter(
    (r) => !isInterruptRequestExpired(r, state),
  );
}
