/**
 * @avalon/shared — Game constants for the default 7-player setup.
 *
 * No Mordred / Lady of the Lake (other expansion roles are out of scope).
 */

import type {
  Alignment,
  AutoSpeed,
  GameConfig,
  ModelInfo,
  ModelName,
  PlayerId,
  Role,
} from "./types.js";

export const PLAYER_COUNT = 7;

export const SEAT_ORDER: readonly PlayerId[] = ["A", "B", "C", "D", "E", "F", "G"];

/** The selectable model pool. `label` is shown in the UI; `provider` is informational. */
export const MODEL_POOL: readonly ModelInfo[] = [
  { name: "gpt-5.4", label: "GPT-5.4", provider: "OpenAI" },
  { name: "gpt-5.5", label: "GPT-5.5", provider: "OpenAI" },
  { name: "claude-opus-4-6", label: "Claude Opus 4.6", provider: "Anthropic" },
  { name: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "Anthropic" },
  { name: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "Anthropic" },
  { name: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "DeepSeek" },
  { name: "glm-5.1", label: "GLM-5.1", provider: "Zhipu" },
  { name: "kimi-k2.6", label: "Kimi K2.6", provider: "Moonshot" },
  { name: "qwen3.6-plus", label: "Qwen3.6 Plus", provider: "Alibaba" },
  { name: "qwen3.7-plus", label: "Qwen3.7 Plus", provider: "Alibaba" },
  { name: "qwen3.7-max", label: "Qwen3.7 Max", provider: "Alibaba" },
];

export const MODEL_NAMES: readonly ModelName[] = MODEL_POOL.map((m) => m.name);

export function isModelName(x: unknown): x is ModelName {
  return typeof x === "string" && MODEL_NAMES.includes(x as ModelName);
}

// ---------------------------------------------------------------------------
// Roles (default 7-player setup): 4 good, 3 evil.
// ---------------------------------------------------------------------------

export const GOOD_ROLES: readonly Role[] = [
  "Merlin",
  "Percival",
  "Loyal Servant",
  "Loyal Servant",
];

export const EVIL_ROLES: readonly Role[] = ["Assassin", "Morgana", "Oberon"];

/** The full role bag dealt at game start (4 good + 3 evil = 7). */
export const ROLE_BAG: readonly Role[] = [...GOOD_ROLES, ...EVIL_ROLES];

export const ROLE_ALIGNMENT: Record<Role, "good" | "evil"> = {
  Merlin: "good",
  Percival: "good",
  "Loyal Servant": "good",
  Assassin: "evil",
  Morgana: "evil",
  Oberon: "evil",
};

// ---------------------------------------------------------------------------
// 7-player quest table. NOTE: Quest 4 requires 2 fail cards to fail.
// ---------------------------------------------------------------------------

export interface QuestTableEntry {
  required_players: number;
  fail_cards_required: number;
}

export const QUEST_TABLE: readonly QuestTableEntry[] = [
  { required_players: 2, fail_cards_required: 1 }, // Quest 1
  { required_players: 3, fail_cards_required: 1 }, // Quest 2
  { required_players: 3, fail_cards_required: 1 }, // Quest 3
  { required_players: 4, fail_cards_required: 2 }, // Quest 4  <-- 2 fails
  { required_players: 4, fail_cards_required: 1 }, // Quest 5
];

export const TOTAL_QUESTS = QUEST_TABLE.length; // 5
export const QUESTS_TO_WIN = 3;

/** Max consecutive rejected team proposals in one quest before evil wins. */
export const MAX_PROPOSAL_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Discussion / interrupt mechanics.
// ---------------------------------------------------------------------------

// The interrupt "collection wait": how long to wait for polled players' (low-
// reasoning) interrupt-intent replies. The poll returns as soon as everyone has
// answered, so this is really the straggler cap. Sub-second is too short for
// real models (they take seconds), so the default is several seconds; mock games
// answer instantly and don't actually wait.
export const INTERRUPT_WINDOW_MS_DEFAULT = 15000;
export const INTERRUPT_WINDOW_MS_MIN = 500;
export const INTERRUPT_WINDOW_MS_MAX = 20000;

/** Each player may actively interrupt at most this many times per discussion phase. */
export const MAX_INTERRUPTS_PER_PLAYER_PER_PHASE = 2;
/** Each discussion phase may contain at most this many total interrupt speeches. */
export const MAX_INTERRUPT_SPEECHES_PER_PHASE = 8;
/** After getting an interrupt speech, a player cannot actively interrupt for N speech events. */
export const INTERRUPT_COOLDOWN_EVENTS = 2;
/** Interrupt requests expire after this many public speech events. */
export const INTERRUPT_REQUEST_TTL_SPEECHES = 2;
/** Directed dialogue cap: Question -> Reply -> follow-up (2 reply turns). */
export const DIRECTED_DIALOGUE_MAX_EXCHANGES = 2;

// ---------------------------------------------------------------------------
// Auto-run speeds (UI-driven stepping cadence, ms between steps).
// ---------------------------------------------------------------------------

export const AUTO_SPEED_MS: Record<AutoSpeed, number> = {
  slow: 2500,
  medium: 1200,
  fast: 350,
};

// ---------------------------------------------------------------------------
// Length constraints for model speech (characters), passed into prompts.
// ---------------------------------------------------------------------------

export const SPEECH_MAX_CHARS = 600;
export const INTERRUPT_INTENT_MAX_CHARS = 120;

// ---------------------------------------------------------------------------
// Default configuration.
// ---------------------------------------------------------------------------

export const DEFAULT_SEATS: Record<PlayerId, ModelName> = {
  A: "claude-opus-4-8",
  B: "gpt-5.5",
  C: "claude-opus-4-6",
  D: "deepseek-v4-pro",
  E: "gpt-5.4",
  F: "qwen3.7-max",
  G: "glm-5.1",
};

export function defaultConfig(): GameConfig {
  return {
    seats: { ...DEFAULT_SEATS },
    randomize_seats: false,
    mock: true,
    interrupt_window_ms: INTERRUPT_WINDOW_MS_DEFAULT,
    evil_fail_probability: 0.7,
    seed: null,
    human_seat: null,
  };
}

/** Human-friendly seat display name (Chinese). */
export function seatDisplayName(id: PlayerId): string {
  return `玩家${id}`;
}

/** Short player label used in transcripts/UI, e.g. "玩家A". */
export function playerLabel(id: PlayerId): string {
  return `玩家${id}`;
}

/** Chinese display labels for roles (internal Role enum values stay English). */
export const ROLE_LABEL_ZH: Record<Role, string> = {
  Merlin: "梅林",
  Percival: "派西维尔",
  "Loyal Servant": "忠臣",
  Assassin: "刺客",
  Morgana: "莫甘娜",
  Oberon: "奥伯伦",
};

export function roleLabel(role: Role): string {
  return ROLE_LABEL_ZH[role];
}

/** Chinese display labels for alignment. */
export const ALIGNMENT_LABEL_ZH: Record<Alignment, string> = {
  good: "正义方",
  evil: "邪恶方",
};

export function alignmentLabel(a: Alignment): string {
  return ALIGNMENT_LABEL_ZH[a];
}
