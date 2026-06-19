/**
 * Pure Avalon rule functions. No state mutation, no I/O — just game logic.
 */

import {
  MAX_PROPOSAL_ATTEMPTS,
  QUEST_TABLE,
  QUESTS_TO_WIN,
  SEAT_ORDER,
  type Alignment,
  type GameState,
  type PlayerId,
  type QuestState,
} from "@avalon/shared";

export function requiredTeamSize(questIndex: number): number {
  const entry = QUEST_TABLE[questIndex];
  if (!entry) throw new Error(`invalid quest index: ${questIndex}`);
  return entry.required_players;
}

export function failCardsRequired(questIndex: number): number {
  const entry = QUEST_TABLE[questIndex];
  if (!entry) throw new Error(`invalid quest index: ${questIndex}`);
  return entry.fail_cards_required;
}

export function buildInitialQuests(): QuestState[] {
  return QUEST_TABLE.map((entry, index) => ({
    index,
    required_players: entry.required_players,
    fail_cards_required: entry.fail_cards_required,
    team: null,
    leader: null,
    result: null,
    fail_count: null,
  }));
}

export interface VoteTally {
  approvals: PlayerId[];
  rejections: PlayerId[];
  passed: boolean;
}

/** A team is approved on a strict majority of approve votes. */
export function tallyVotes(votes: Record<PlayerId, boolean | null>): VoteTally {
  const approvals: PlayerId[] = [];
  const rejections: PlayerId[] = [];
  for (const id of SEAT_ORDER) {
    const v = votes[id];
    if (v === true) approvals.push(id);
    else if (v === false) rejections.push(id);
  }
  return { approvals, rejections, passed: approvals.length > rejections.length };
}

export interface MissionResolution {
  success_count: number;
  fail_count: number;
  passed: boolean;
}

export function resolveMission(
  cards: ("success" | "fail")[],
  failCardsRequired: number,
): MissionResolution {
  let fail_count = 0;
  for (const c of cards) if (c === "fail") fail_count += 1;
  const success_count = cards.length - fail_count;
  return { success_count, fail_count, passed: fail_count < failCardsRequired };
}

export function countSuccessfulQuests(quests: QuestState[]): number {
  return quests.filter((q) => q.result === "success").length;
}

export function countFailedQuests(quests: QuestState[]): number {
  return quests.filter((q) => q.result === "fail").length;
}

/** Good has completed enough quests to trigger the assassination phase. */
export function goodReachedQuestGoal(quests: QuestState[]): boolean {
  return countSuccessfulQuests(quests) >= QUESTS_TO_WIN;
}

export function evilReachedQuestGoal(quests: QuestState[]): boolean {
  return countFailedQuests(quests) >= QUESTS_TO_WIN;
}

export interface WinResult {
  winner: Alignment;
  reason: string;
}

/**
 * Quest-driven terminal outcomes that do not require the assassination step.
 * Returns null when the game is not decided by quest count alone.
 */
export function checkQuestWin(quests: QuestState[]): WinResult | null {
  if (evilReachedQuestGoal(quests)) {
    return { winner: "evil", reason: "Evil caused 3 quests to fail." };
  }
  return null;
}

/** True when this many rejected proposals in a single quest means evil wins. */
export function rejectionsExhausted(proposalAttempt: number): boolean {
  // proposalAttempt is the 1-based index of the proposal that was just rejected.
  return proposalAttempt >= MAX_PROPOSAL_ATTEMPTS;
}

/** Clockwise next leader by seat order. */
export function nextLeader(current: PlayerId, seatOrder: PlayerId[]): PlayerId {
  const idx = seatOrder.indexOf(current);
  return seatOrder[(idx + 1) % seatOrder.length]!;
}

/** Legal team for a quest: correct size, all distinct, all real seats. */
export function isValidTeam(team: PlayerId[], questIndex: number, state: GameState): boolean {
  const size = requiredTeamSize(questIndex);
  if (team.length !== size) return false;
  const set = new Set(team);
  if (set.size !== team.length) return false;
  for (const id of team) {
    if (!state.players[id]) return false;
  }
  return true;
}
