/**
 * Replay projection. Folds a loaded game's public event log up to a timeline
 * index into a renderable PublicGameView (+ GodView when god data is present),
 * so the existing table/quest/chat components can render any past moment.
 *
 * Pure + client-side: no server round-trips, no model calls. The timeline steps
 * over PUBLIC events (the spectator narrative). In god mode, roles are static
 * (always known) and mission cards are revealed only up to the current frame.
 */

import {
  SEAT_ORDER,
  seatDisplayName,
  type Alignment,
  type GameEvent,
  type GodView,
  type ModelName,
  type PlayerId,
  type PlayerState,
  type PublicEvent,
  type PublicGameView,
  type PublicPlayerInfo,
  type PublicQuestInfo,
  type QuestState,
} from "@avalon/shared";
import type { Snapshot } from "./useGameSocket";

const PUBLIC_TYPES: ReadonlySet<GameEvent["type"]> = new Set([
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

const QUEST_TABLE = [
  { required_players: 2, fail_cards_required: 1 },
  { required_players: 3, fail_cards_required: 1 },
  { required_players: 3, fail_cards_required: 1 },
  { required_players: 4, fail_cards_required: 2 },
  { required_players: 4, fail_cards_required: 1 },
];

export interface ReplayFrame {
  pub: PublicGameView;
  god: GodView | null;
  total: number;
}

interface Statics {
  game_id: string;
  seat_order: PlayerId[];
  models: Record<PlayerId, ModelName>;
  /** god-only: full player records (roles/private views are static all game). */
  players?: Record<PlayerId, PlayerState>;
  fullLog?: GameEvent[];
}

/** Extract the public-event timeline + static identity info from a snapshot. */
function readSnapshot(snapshot: Snapshot): { publicEvents: PublicEvent[]; statics: Statics } {
  if (snapshot.mode === "god") {
    const s = snapshot.view.state;
    const models = {} as Record<PlayerId, ModelName>;
    for (const id of s.seat_order) models[id] = s.players[id].model;
    return {
      publicEvents: s.event_log.filter((e) => PUBLIC_TYPES.has(e.type)) as PublicEvent[],
      statics: {
        game_id: s.game_id,
        seat_order: s.seat_order,
        models,
        players: s.players,
        fullLog: s.event_log,
      },
    };
  }
  const v = snapshot.view;
  const models = {} as Record<PlayerId, ModelName>;
  for (const p of v.players) models[p.id] = p.model;
  return {
    publicEvents: v.public_event_log,
    statics: { game_id: v.game_id, seat_order: v.seat_order, models },
  };
}

function blankQuests(): QuestState[] {
  return QUEST_TABLE.map((q, index) => ({
    index,
    required_players: q.required_players,
    fail_cards_required: q.fail_cards_required,
    team: null,
    leader: null,
    result: null,
    fail_count: null,
  }));
}

interface Folded {
  leader: PlayerId | null;
  phase: PublicGameView["phase"];
  proposedTeam: PlayerId[] | null;
  currentSpeaker: PlayerId | null;
  quests: QuestState[];
  questIndex: number;
  lastVotes: Record<PlayerId, boolean | null>;
  winner: Alignment | null;
  reason: string | null;
  proposalAttempt: number;
  rejections: number;
  revealedIdentities: PublicGameView["revealed_identities"];
  postgameCompleted: PlayerId[];
}

function fold(slice: PublicEvent[], seat: PlayerId[]): Folded {
  const f: Folded = {
    leader: null,
    phase: "setup",
    proposedTeam: null,
    currentSpeaker: null,
    quests: blankQuests(),
    questIndex: 0,
    lastVotes: Object.fromEntries(seat.map((id) => [id, null])) as Record<PlayerId, boolean | null>,
    winner: null,
    reason: null,
    proposalAttempt: 1,
    rejections: 0,
    revealedIdentities: null,
    postgameCompleted: [],
  };

  for (const e of slice) {
    switch (e.type) {
      case "leader_changed":
        f.leader = e.leader;
        break;
      case "phase_changed":
        f.phase = e.to;
        break;
      case "team_proposed":
        f.proposedTeam = e.team;
        f.leader = e.leader;
        break;
      case "public_speech":
        f.currentSpeaker = e.player;
        if (e.source === "postgame_review" && !f.postgameCompleted.includes(e.player)) {
          f.postgameCompleted.push(e.player);
        }
        break;
      case "vote_revealed": {
        for (const id of seat) f.lastVotes[id] = null;
        for (const id of e.approvals) f.lastVotes[id] = true;
        for (const id of e.rejections) f.lastVotes[id] = false;
        if (!e.passed) {
          f.rejections += 1;
          f.proposalAttempt += 1;
        }
        break;
      }
      case "mission_result": {
        const q = f.quests[e.quest_index];
        if (q) {
          q.result = e.passed ? "success" : "fail";
          q.fail_count = e.fail_count;
          q.team = e.team;
        }
        f.questIndex = Math.min(e.quest_index + 1, QUEST_TABLE.length - 1);
        f.proposedTeam = null;
        f.proposalAttempt = 1;
        f.rejections = 0;
        f.currentSpeaker = null;
        break;
      }
      case "assassination_attempt":
        f.currentSpeaker = e.assassin;
        break;
      case "game_over":
        f.winner = e.winner;
        f.reason = e.reason;
        f.currentSpeaker = null;
        break;
      case "postgame_roles_revealed":
        f.revealedIdentities = e.identities;
        f.currentSpeaker = null;
        break;
      default:
        break;
    }
  }

  // The "currently speaking" glow only makes sense if the last shown event was a speech.
  const last = slice[slice.length - 1];
  if (!last || last.type !== "public_speech") f.currentSpeaker = null;

  return f;
}

function statusFor(id: PlayerId, f: Folded): PublicPlayerInfo["status"] {
  if (f.currentSpeaker === id) return "speaking";
  if (f.winner) return "idle";
  if (f.leader === id) return "leader";
  return "idle";
}

function buildPublic(slice: PublicEvent[], statics: Statics, f: Folded): PublicGameView {
  const leader = f.leader ?? statics.seat_order[0]!;
  const postgameStarted = f.revealedIdentities !== null;
  const postgameDone = postgameStarted && f.postgameCompleted.length >= statics.seat_order.length;
  const nextPostgamePlayer =
    postgameStarted && !postgameDone
      ? statics.seat_order.find((id) => !f.postgameCompleted.includes(id)) ?? null
      : null;
  const questHistory: PublicQuestInfo[] = f.quests.map((q) => ({
    index: q.index,
    required_players: q.required_players,
    fail_cards_required: q.fail_cards_required,
    result: q.result,
    fail_count: q.result === null ? null : q.fail_count,
    team: q.result === null ? null : q.team,
    leader: q.leader,
  }));

  const players: PublicPlayerInfo[] = statics.seat_order.map((id) => ({
    id,
    display_name: seatDisplayName(id),
    model: statics.models[id],
    status: statusFor(id, f),
    is_leader: leader === id,
    is_current_speaker: f.currentSpeaker === id,
    is_on_proposed_team: f.proposedTeam?.includes(id) ?? false,
    is_targeted: false,
    has_pending_interrupt: false,
    in_cooldown: false,
    last_vote: f.lastVotes[id] ?? null,
  }));

  return {
    game_id: statics.game_id,
    status: f.winner ? "completed" : slice.length === 0 ? "not_started" : "running",
    phase: f.phase,
    quest_index: f.questIndex,
    leader,
    current_speaker: f.currentSpeaker,
    next_normal_speaker: null,
    proposed_team: f.proposedTeam,
    proposal_attempt: f.proposalAttempt,
    consecutive_rejections: f.rejections,
    players,
    seat_order: statics.seat_order.slice(),
    quest_history: questHistory,
    public_event_log: slice,
    pending_interrupts: 0,
    human_seat: null,
    pending_human: null,
    winner: f.winner,
    game_over_reason: f.reason,
    postgame_review: {
      status: !postgameStarted ? "not_started" : postgameDone ? "completed" : "running",
      next_player: nextPostgamePlayer,
      completed_players: f.postgameCompleted.slice(),
    },
    revealed_identities: f.revealedIdentities,
  };
}

function replayNotes(fullSlice: GameEvent[], seatOrder: PlayerId[]): Record<PlayerId, string[]> {
  const notes = {} as Record<PlayerId, string[]>;
  for (const id of seatOrder) notes[id] = [];
  for (const e of fullSlice) {
    if (e.type === "private_memo") notes[e.player].push(e.memo);
  }
  return notes;
}

function playersWithReplayNotes(
  players: Record<PlayerId, PlayerState>,
  notes: Record<PlayerId, string[]>,
): Record<PlayerId, PlayerState> {
  const out = {} as Record<PlayerId, PlayerState>;
  for (const id of SEAT_ORDER) {
    const p = players[id];
    out[id] = {
      ...p,
      private_view: {
        ...p.private_view,
        notes: notes[id].slice(),
      },
    };
  }
  return out;
}

export function replayTotal(snapshot: Snapshot): number {
  return readSnapshot(snapshot).publicEvents.length;
}

/** Project the game state as of the first `idx` public events. */
export function projectReplay(snapshot: Snapshot, idx: number): ReplayFrame {
  const { publicEvents, statics } = readSnapshot(snapshot);
  const total = publicEvents.length;
  const n = Math.max(0, Math.min(idx, total));
  const slice = publicEvents.slice(0, n);
  const f = fold(slice, statics.seat_order);
  const pub = buildPublic(slice, statics, f);

  let god: GodView | null = null;
  if (snapshot.mode === "god" && statics.fullLog) {
    const baseState = snapshot.view.state;
    // Map the public-timeline cut to a position in the full log so god-only
    // details (mission cards) are revealed only up to this frame.
    const lastShown = slice[slice.length - 1];
    const fullCut = lastShown
      ? statics.fullLog.findIndex((e) => e.event_id === lastShown.event_id)
      : -1;
    const fullSlice = statics.fullLog.slice(0, fullCut + 1);
    const notes = replayNotes(fullSlice, baseState.seat_order);
    god = {
      state: {
        ...baseState,
        players: playersWithReplayNotes(baseState.players, notes),
        event_log: fullSlice,
        round: {
          quest_index: f.questIndex,
          leader: pub.leader,
          proposal_attempt: f.proposalAttempt,
          proposed_team: f.proposedTeam,
          normal_speech_index: 0,
          current_speaker: f.currentSpeaker,
          next_normal_speaker: null,
          normal_queue: [],
        },
        quests: f.quests,
        status: pub.status,
        phase: f.phase,
        winner: f.winner,
        game_over_reason: f.reason,
        postgame_review: {
          status: pub.postgame_review.status,
          next_index:
            pub.postgame_review.status === "not_started"
              ? 0
              : pub.postgame_review.next_player
                ? baseState.seat_order.indexOf(pub.postgame_review.next_player)
                : baseState.seat_order.length,
          completed_players: pub.postgame_review.completed_players.slice(),
        },
      },
      public_view: pub,
      interrupt_scores: {},
    };
  }

  return { pub, god, total };
}
