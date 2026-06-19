/**
 * Event helpers: stamping drafts with id+timestamp, and querying the event log.
 * The event log is the source of truth (event-sourced); state caches projections.
 */

import type { GameEvent, GameState, PlayerId } from "@avalon/shared";
import type { IdGen } from "../utils/ids.js";

/** Distribute Omit across the GameEvent union so each variant loses the stamp fields. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** A game event without its controller-assigned id/timestamp. */
export type EventDraft = DistributiveOmit<GameEvent, "event_id" | "timestamp">;

export function stampEvent(idgen: IdGen, draft: EventDraft): GameEvent {
  return {
    ...(draft as object),
    event_id: idgen.next("evt"),
    timestamp: Date.now(),
  } as GameEvent;
}

/** Most recent public_speech event, or null. */
export function getLastPublicSpeechEvent(
  state: GameState,
): Extract<GameEvent, { type: "public_speech" }> | null {
  for (let i = state.event_log.length - 1; i >= 0; i--) {
    const e = state.event_log[i]!;
    if (e.type === "public_speech") return e;
  }
  return null;
}

/** Number of public_speech events committed so far (the interrupt "clock"). */
export function publicSpeechCount(state: GameState): number {
  let n = 0;
  for (const e of state.event_log) if (e.type === "public_speech") n += 1;
  return n;
}

/** The player who delivered the most recent public speech, or null. */
export function lastSpeaker(state: GameState): PlayerId | null {
  const e = getLastPublicSpeechEvent(state);
  return e ? e.player : null;
}

export function findEvent(
  state: GameState,
  eventId: string,
): GameEvent | undefined {
  return state.event_log.find((e) => e.event_id === eventId);
}
