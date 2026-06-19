/**
 * @avalon/shared — Core type definitions.
 *
 * These types are shared between the server (authoritative controller) and the
 * web client (pure renderer). The controller is the only writer of game state;
 * the client renders projections (PublicGameView / GodView) and dispatches
 * control commands.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type PlayerId = "A" | "B" | "C" | "D" | "E" | "F" | "G";

export const PLAYER_IDS: readonly PlayerId[] = ["A", "B", "C", "D", "E", "F", "G"];

export type Role =
  | "Merlin"
  | "Percival"
  | "Loyal Servant"
  | "Assassin"
  | "Morgana"
  | "Oberon";

export type Alignment = "good" | "evil";

/** The user-selectable model pool. The adapter layer maps these to the gateway. */
export type ModelName =
  | "gpt-5.4"
  | "gpt-5.5"
  | "claude-opus-4-6"
  | "claude-opus-4-8"
  | "claude-sonnet-4-6"
  | "deepseek-v4-pro"
  | "glm-5.1"
  | "kimi-k2.6"
  | "qwen3.6-plus"
  | "qwen3.7-plus"
  | "qwen3.7-max";

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export type GamePhase =
  | "setup"
  | "role_reveal_private"
  | "leader_proposal"
  | "discussion"
  | "normal_speech"
  | "interrupt_collect"
  | "interrupt_speech"
  | "directed_reply"
  | "team_finalize"
  | "team_vote"
  | "vote_reveal"
  | "mission_action"
  | "mission_reveal"
  | "assassination_discuss"
  | "assassination"
  | "game_over";

// ---------------------------------------------------------------------------
// Player actions (model output). Models may ONLY emit these shapes.
// ---------------------------------------------------------------------------

export type PlayerAction =
  | { action: "pass" }
  | { action: "request_interrupt"; target?: PlayerId | null; speech?: string }
  | { action: "withdraw_interrupt"; request_id: string }
  | { action: "speak"; target?: PlayerId | null; speech: string; memo?: string }
  | { action: "propose_team"; team: PlayerId[]; speech?: string; memo?: string }
  | { action: "vote"; approve: boolean; memo?: string }
  | { action: "mission_card"; card: "success" | "fail"; memo?: string }
  | { action: "assassinate"; target: PlayerId; speech?: string; memo?: string };

export type PlayerActionType = PlayerAction["action"];

/** Which prompt the controller is issuing — selects schema + legal actions. */
export type PromptType =
  | "interrupt_intent"
  | "full_speech"
  | "full_speech_optional"
  | "leader_discussion"
  | "leader_proposal"
  | "vote"
  | "mission"
  | "assassination_decision"
  | "assassination"
  | "postgame_review";

// ---------------------------------------------------------------------------
// Game events (controller-committed facts; the event-sourced log).
// ---------------------------------------------------------------------------

export type EventVisibility =
  | "public"
  | "god_only"
  | "god_only_until_reveal";

export type SpeechSource =
  | "normal"
  | "interrupt"
  | "directed_reply"
  | "leader_final"
  | "postgame_review";

export interface RevealedIdentity {
  role: Role;
  alignment: Alignment;
}

export type RevealedIdentities = Record<PlayerId, RevealedIdentity>;

export type PostgameReviewStatus =
  | "not_started"
  | "running"
  | "waiting_human"
  | "completed";

export interface PostgameReviewState {
  status: PostgameReviewStatus;
  next_index: number;
  completed_players: PlayerId[];
}

export interface PublicPostgameReviewState {
  status: PostgameReviewStatus;
  next_player: PlayerId | null;
  completed_players: PlayerId[];
}

export type GameEvent =
  | { type: "game_created"; event_id: string; timestamp: number }
  | {
      type: "role_assigned";
      event_id: string;
      timestamp: number;
      player: PlayerId;
      role: Role;
      alignment: Alignment;
      visibility: "god_only";
    }
  | {
      type: "phase_changed";
      event_id: string;
      timestamp: number;
      from: GamePhase;
      to: GamePhase;
    }
  | {
      type: "leader_changed";
      event_id: string;
      timestamp: number;
      leader: PlayerId;
    }
  | {
      type: "team_proposed";
      event_id: string;
      timestamp: number;
      leader: PlayerId;
      team: PlayerId[];
      speech?: string;
    }
  | {
      type: "public_speech";
      event_id: string;
      timestamp: number;
      player: PlayerId;
      target?: PlayerId | null;
      speech: string;
      source: SpeechSource;
    }
  | {
      // A player declined their normal-speech turn (round-1 discussion only).
      // Public so spectators and other models see who chose to pass.
      type: "speech_passed";
      event_id: string;
      timestamp: number;
      player: PlayerId;
    }
  | {
      type: "interrupt_requested";
      event_id: string;
      timestamp: number;
      request_id: string;
      player: PlayerId;
      target?: PlayerId | null;
      speech: string;
      anchor_event_id: string;
      score: number;
      visibility: "god_only" | "public";
    }
  | {
      type: "interrupt_granted";
      event_id: string;
      timestamp: number;
      request_id: string;
      player: PlayerId;
    }
  | {
      type: "interrupt_rejected";
      event_id: string;
      timestamp: number;
      request_id?: string;
      player: PlayerId;
      reason: string;
      visibility: "god_only";
    }
  | {
      type: "vote_cast";
      event_id: string;
      timestamp: number;
      player: PlayerId;
      approve: boolean;
      visibility: "god_only_until_reveal";
    }
  | {
      type: "vote_revealed";
      event_id: string;
      timestamp: number;
      approvals: PlayerId[];
      rejections: PlayerId[];
      passed: boolean;
    }
  | {
      type: "mission_card_submitted";
      event_id: string;
      timestamp: number;
      player: PlayerId;
      card: "success" | "fail";
      visibility: "god_only";
    }
  | {
      type: "mission_result";
      event_id: string;
      timestamp: number;
      quest_index: number;
      team: PlayerId[];
      success_count: number;
      fail_count: number;
      passed: boolean;
    }
  | {
      type: "assassination_attempt";
      event_id: string;
      timestamp: number;
      assassin: PlayerId;
      target: PlayerId;
      target_was_merlin: boolean;
    }
  | {
      type: "game_over";
      event_id: string;
      timestamp: number;
      winner: Alignment;
      reason: string;
    }
  | {
      type: "postgame_roles_revealed";
      event_id: string;
      timestamp: number;
      identities: RevealedIdentities;
    }
  | {
      type: "model_raw_response";
      event_id: string;
      timestamp: number;
      player: PlayerId;
      prompt_type: PromptType;
      raw: unknown;
      visibility: "god_only";
    }
  | {
      type: "model_action_rejected";
      event_id: string;
      timestamp: number;
      player: PlayerId;
      action: unknown;
      reason: string;
      visibility: "god_only";
    }
  | {
      type: "private_memo";
      event_id: string;
      timestamp: number;
      player: PlayerId;
      memo: string;
      visibility: "god_only";
    };

export type GameEventType = GameEvent["type"];

// ---------------------------------------------------------------------------
// Authoritative game state.
// ---------------------------------------------------------------------------

export type GameStatus = "not_started" | "running" | "paused" | "completed";

export type PlayerStatus =
  | "idle"
  | "leader"
  | "speaking"
  | "interrupt_queue"
  | "cooldown"
  | "targeted"
  | "voting"
  | "on_mission"
  | "assassinating";

export interface PrivatePlayerView {
  you: PlayerId;
  role: Role;
  alignment: Alignment;
  model: ModelName;

  /** Merlin only: the evil players Merlin can see. */
  known_evil_players?: PlayerId[];
  /** Percival only: Merlin + Morgana, shuffled (Percival cannot tell which is which). */
  merlin_candidates?: PlayerId[];
  /** Evil only: the evil players this player knows. Oberon only knows themself. */
  evil_team?: PlayerId[];

  strategic_reminder: string;
  /** Private scratchpad written by this player's own model; never appears in public view. */
  notes: string[];
}

export interface PlayerState {
  id: PlayerId;
  display_name: string;
  model: ModelName;

  role: Role;
  alignment: Alignment;

  status: PlayerStatus;

  private_view: PrivatePlayerView;
}

export interface QuestState {
  index: number;
  required_players: number;
  fail_cards_required: number;
  team: PlayerId[] | null;
  /** Leader of the approved proposal that sent this quest, set when the mission runs. */
  leader: PlayerId | null;
  result: "success" | "fail" | null;
  fail_count: number | null;
}

export interface InterruptRequest {
  request_id: string;
  player: PlayerId;
  target?: PlayerId | null;
  speech: string;
  anchor_event_id: string;
  arrival_seq: number;
  created_at_event_index: number;
  expires_after_event_index: number;
  score: number;
}

export interface PlayerTalkStats {
  normal_speeches_in_phase: number;
  interrupts_in_phase: number;
  interrupts_in_round: number;
  total_interrupts: number;
  last_spoke_event_index: number | null;
  cooldown_until_event_index: number | null;
}

export interface DirectedDialogueState {
  /** The player who addressed the target (asked the question). */
  initiator: PlayerId;
  /** The player who owes a reply. */
  target: PlayerId;
  /** Number of reply turns already taken within this directed exchange. */
  exchanges: number;
  /** Hard cap on reply turns: Question -> Reply -> follow-up. */
  max_exchanges: number;
  anchor_event_id: string;
  /**
   * Special case: the target was already the next normal speaker, so their
   * directed reply is merged with their normal speech (no extra separate turn).
   */
  merged_with_normal: boolean;
}

export interface RoundState {
  quest_index: number;
  leader: PlayerId;
  proposal_attempt: number;
  proposed_team: PlayerId[] | null;
  normal_speech_index: number;
  current_speaker: PlayerId | null;
  next_normal_speaker: PlayerId | null;
  /** Seats still to take their normal discussion turn this phase, in order. */
  normal_queue: PlayerId[];
}

/** When a human seat must act, the controller pauses and waits for this. */
export interface PendingHuman {
  player: PlayerId;
  prompt_type: PromptType;
  legal_actions: PlayerActionType[];
  context_note?: string;
}

export interface GameState {
  game_id: string;
  status: GameStatus;
  created_at: number;

  players: Record<PlayerId, PlayerState>;
  /** Fixed clockwise seat order (table order). */
  seat_order: PlayerId[];

  phase: GamePhase;

  round: RoundState;

  quests: QuestState[];

  votes: Record<PlayerId, boolean | null>;

  mission: {
    active: boolean;
    team: PlayerId[];
    cards: Record<PlayerId, "success" | "fail" | null>;
  };

  interrupts: {
    queue: InterruptRequest[];
    phase_budget_remaining: number;
    directed_dialogue: DirectedDialogueState | null;
    /** The interrupt request granted the floor, awaiting its speech. */
    granted: { request_id: string; player: PlayerId } | null;
    /** Monotonic counter for FIFO tie-breaking of interrupt requests. */
    arrival_counter: number;
    /** A pending human "grab the floor" request — always wins interrupt priority. */
    human_request: { target?: PlayerId | null; speech: string } | null;
  };

  talk_stats: Record<PlayerId, PlayerTalkStats>;

  event_log: GameEvent[];

  config: GameConfig;

  /** Set when a human seat must act; the controller blocks until it is submitted. */
  pending_human: PendingHuman | null;

  winner: Alignment | null;
  game_over_reason: string | null;

  /** Optional post-game identity reveal + one-seat-at-a-time review flow. */
  postgame_review: PostgameReviewState;

  /** God-only: most recent raw model interactions, for the debug drawer. */
  last_model_calls: ModelCallRecord[];
}

// ---------------------------------------------------------------------------
// Configuration (game creation).
// ---------------------------------------------------------------------------

export interface GameConfig {
  /** Model assigned to each seat. Decoupled from role assignment. */
  seats: Record<PlayerId, ModelName>;
  /** Shuffle which seat gets which configured model before start. */
  randomize_seats: boolean;
  /** Use mock adapters (no API calls). Default true for offline play. */
  mock: boolean;
  /** Interrupt collection window in ms (500–1200, default 800). */
  interrupt_window_ms: number;
  /** Mock-only: probability an evil player plays a fail card on a mission. */
  evil_fail_probability: number;
  /** Optional deterministic seed for role assignment / mock behavior. */
  seed: number | null;
  /** Seat played by the human (null = all AI). The human always wins interrupts. */
  human_seat: PlayerId | null;
}

// ---------------------------------------------------------------------------
// Projections / views.
// ---------------------------------------------------------------------------

export type SpectatorMode = "god" | "no_vision";

export interface PublicPlayerInfo {
  id: PlayerId;
  display_name: string;
  model: ModelName;
  status: PlayerStatus;
  is_leader: boolean;
  is_current_speaker: boolean;
  is_on_proposed_team: boolean;
  is_targeted: boolean;
  has_pending_interrupt: boolean;
  in_cooldown: boolean;
  /** Public vote status, only meaningful after a reveal. */
  last_vote: boolean | null;
}

export interface PublicQuestInfo {
  index: number;
  required_players: number;
  fail_cards_required: number;
  result: "success" | "fail" | null;
  /** Number of fail cards is public after reveal; null before. */
  fail_count: number | null;
  team: PlayerId[] | null;
  leader: PlayerId | null;
}

/** Public-safe subset of GameEvent (no god-only / pre-reveal data). */
export type PublicEvent = Extract<
  GameEvent,
  | { type: "game_created" }
  | { type: "phase_changed" }
  | { type: "leader_changed" }
  | { type: "team_proposed" }
  | { type: "public_speech" }
  | { type: "speech_passed" }
  | { type: "interrupt_granted" }
  | { type: "vote_revealed" }
  | { type: "mission_result" }
  | { type: "assassination_attempt" }
  | { type: "game_over" }
  | { type: "postgame_roles_revealed" }
>;

export interface PublicGameView {
  game_id: string;
  status: GameStatus;
  phase: GamePhase;
  quest_index: number;
  leader: PlayerId;
  current_speaker: PlayerId | null;
  next_normal_speaker: PlayerId | null;
  proposed_team: PlayerId[] | null;
  proposal_attempt: number;
  consecutive_rejections: number;
  players: PublicPlayerInfo[];
  seat_order: PlayerId[];
  quest_history: PublicQuestInfo[];
  public_event_log: PublicEvent[];
  pending_interrupts: number;
  /** Seat the human is playing (null = all AI). Public-safe: not a role/alignment. */
  human_seat: PlayerId | null;
  /** Set when the human must act now (their turn or a granted interrupt). */
  pending_human: PendingHuman | null;
  winner: Alignment | null;
  game_over_reason: string | null;
  postgame_review: PublicPostgameReviewState;
  revealed_identities: RevealedIdentities | null;
}

/** Full god-mode projection: authoritative state plus computed debug aids. */
export interface GodView {
  state: GameState;
  public_view: PublicGameView;
  /** Live interrupt priority scores keyed by request_id (debug drawer). */
  interrupt_scores: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Model adapter layer.
// ---------------------------------------------------------------------------

/** How hard the model should think on a given call. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ModelCallInput {
  player_id: PlayerId;
  model: ModelName;
  phase: GamePhase;
  prompt_type: PromptType;
  private_view: PrivatePlayerView;
  public_view: PublicGameView;
  legal_actions: PlayerActionType[];
  schema_name: string;
  /** Extra controller-supplied context (e.g. who addressed you). */
  context_note?: string;
  /** Per-call reasoning effort (controller sets it by action type; falls back to the server default). */
  effort?: ReasoningEffort;
}

export interface ModelUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** OpenAI-compatible cached prompt tokens, when the gateway reports them. */
  cached_input_tokens?: number;
  /** Anthropic prompt-cache write tokens. */
  cache_creation_input_tokens?: number;
  /** Anthropic prompt-cache read tokens. */
  cache_read_input_tokens?: number;
  cost_usd?: number;
}

export interface ModelCallResult {
  raw_text: string;
  parsed_action: PlayerAction | null;
  usage?: ModelUsage;
  latency_ms: number;
  error?: string;
  /** Number of attempts (including reprompts) the adapter made. */
  attempts?: number;
}

/** God-only record kept on state for the debug drawer. */
export interface ModelCallRecord {
  player: PlayerId;
  model: ModelName;
  prompt_type: PromptType;
  phase: GamePhase;
  raw_text: string;
  parsed_action: PlayerAction | null;
  accepted: boolean;
  reject_reason?: string;
  latency_ms: number;
  usage?: ModelUsage;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Real-time protocol (WebSocket) + REST payloads.
// ---------------------------------------------------------------------------

export type AutoSpeed = "slow" | "medium" | "fast";

export type WsServerMessage =
  | { kind: "snapshot"; mode: "god"; view: GodView }
  | { kind: "snapshot"; mode: "no_vision"; view: PublicGameView }
  | { kind: "model_call_started"; player: PlayerId; prompt_type: PromptType; model: ModelName }
  | {
      kind: "model_call_completed";
      player: PlayerId;
      prompt_type: PromptType;
      latency_ms: number;
      ok: boolean;
    }
  | { kind: "model_action_rejected"; player: PlayerId; reason: string }
  | { kind: "game_over"; winner: Alignment; reason: string }
  | { kind: "notice"; message: string };

export type WsClientMessage =
  | { kind: "set_mode"; mode: SpectatorMode }
  | { kind: "ping" };

export interface ModelInfo {
  name: ModelName;
  label: string;
  provider: string;
}

export interface CreateGameRequest {
  config?: Partial<GameConfig>;
}

export interface CreateGameResponse {
  game_id: string;
}

/** Compact summary for the saved-games list. */
export interface GameSummary {
  game_id: string;
  status: GameStatus;
  phase: GamePhase;
  winner: Alignment | null;
  game_over_reason: string | null;
  quest_index: number;
  created_at: number;
  mock: boolean;
  models: Record<PlayerId, ModelName>;
  num_events: number;
}

export interface ExportBundle {
  game_id: string;
  config: GameConfig;
  final_state: GameState;
  event_log: GameEvent[];
  public_event_log: PublicEvent[];
  result: { winner: Alignment | null; reason: string | null };
  exported_at: number;
}
