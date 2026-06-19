/**
 * @avalon/shared — Runtime validation schemas (Zod).
 *
 * Every model output is validated against these before the controller will
 * consider it. The controller still performs semantic legality checks
 * (correct phase, leader-only proposals, team size, mission membership, etc.).
 *
 * Models must NOT emit control-plane fields (priority, cooldown, score, phase,
 * state transitions, legal-action lists). Those are explicitly rejected.
 */

import { z } from "zod";
import {
  INTERRUPT_WINDOW_MS_MAX,
  INTERRUPT_WINDOW_MS_MIN,
  MODEL_NAMES,
} from "./constants.js";
import type { ModelName, PlayerActionType, PromptType } from "./types.js";

export const playerIdSchema = z.enum(["A", "B", "C", "D", "E", "F", "G"]);

export const modelNameSchema = z.enum(
  MODEL_NAMES as unknown as [ModelName, ...ModelName[]],
);

const targetSchema = playerIdSchema.nullable().optional();
const memoSchema = z.string().max(600).optional();

// ---------------------------------------------------------------------------
// Individual action schemas (kept non-strict so benign extra keys such as
// `reasoning` are stripped rather than rejected; forbidden control-plane keys
// are caught separately by `hasForbiddenControlField`).
// ---------------------------------------------------------------------------

export const passActionSchema = z.object({
  action: z.literal("pass"),
});

export const requestInterruptActionSchema = z.object({
  action: z.literal("request_interrupt"),
  target: targetSchema,
  // Optional: AI interrupt requests are pure intent (the reason was never shown
  // to others nor used in scoring). The human's grab carries their actual line.
  speech: z.string().max(2000).optional(),
});

export const withdrawInterruptActionSchema = z.object({
  action: z.literal("withdraw_interrupt"),
  request_id: z.string().min(1),
});

export const speakActionSchema = z.object({
  action: z.literal("speak"),
  target: targetSchema,
  speech: z.string().min(1).max(4000),
  memo: memoSchema,
});

export const proposeTeamActionSchema = z.object({
  action: z.literal("propose_team"),
  team: z.array(playerIdSchema).min(1).max(7),
  speech: z.string().max(4000).optional(),
  memo: memoSchema,
});

export const voteActionSchema = z.object({
  action: z.literal("vote"),
  approve: z.boolean(),
  memo: memoSchema,
});

export const missionCardActionSchema = z.object({
  action: z.literal("mission_card"),
  card: z.enum(["success", "fail"]),
  memo: memoSchema,
});

export const assassinateActionSchema = z.object({
  action: z.literal("assassinate"),
  target: playerIdSchema,
  speech: z.string().max(4000).optional(),
  memo: memoSchema,
});

/** The full union of every legal action shape. */
export const playerActionSchema = z.discriminatedUnion("action", [
  passActionSchema,
  requestInterruptActionSchema,
  withdrawInterruptActionSchema,
  speakActionSchema,
  proposeTeamActionSchema,
  voteActionSchema,
  missionCardActionSchema,
  assassinateActionSchema,
]);

export type ValidatedPlayerAction = z.infer<typeof playerActionSchema>;

// ---------------------------------------------------------------------------
// Per-prompt-type schemas + allowed action sets.
// ---------------------------------------------------------------------------

export const PROMPT_ALLOWED_ACTIONS: Record<PromptType, PlayerActionType[]> = {
  interrupt_intent: ["pass", "request_interrupt", "withdraw_interrupt"],
  full_speech: ["speak"],
  full_speech_optional: ["speak", "pass"],
  leader_discussion: ["speak", "propose_team"],
  leader_proposal: ["propose_team"],
  vote: ["vote"],
  mission: ["mission_card"],
  assassination_decision: ["speak", "assassinate"],
  assassination: ["assassinate"],
  postgame_review: ["speak"],
};

export const PROMPT_SCHEMAS: Record<PromptType, z.ZodTypeAny> = {
  interrupt_intent: z.discriminatedUnion("action", [
    passActionSchema,
    requestInterruptActionSchema,
    withdrawInterruptActionSchema,
  ]),
  full_speech: speakActionSchema,
  full_speech_optional: z.discriminatedUnion("action", [
    speakActionSchema,
    passActionSchema,
  ]),
  leader_discussion: z.discriminatedUnion("action", [
    speakActionSchema,
    proposeTeamActionSchema,
  ]),
  leader_proposal: proposeTeamActionSchema,
  vote: voteActionSchema,
  mission: missionCardActionSchema,
  assassination_decision: z.discriminatedUnion("action", [
    speakActionSchema,
    assassinateActionSchema,
  ]),
  assassination: assassinateActionSchema,
  postgame_review: speakActionSchema,
};

export const SCHEMA_NAME_BY_PROMPT: Record<PromptType, string> = {
  interrupt_intent: "InterruptIntentAction",
  full_speech: "SpeakAction",
  full_speech_optional: "SpeakOrPassAction",
  leader_discussion: "LeaderDiscussionAction",
  leader_proposal: "ProposeTeamAction",
  vote: "VoteAction",
  mission: "MissionCardAction",
  assassination_decision: "AssassinationDecisionAction",
  assassination: "AssassinateAction",
  postgame_review: "SpeakAction",
};

// ---------------------------------------------------------------------------
// Forbidden control-plane fields. The controller computes all of these; a
// model that tries to emit one has its action rejected outright.
// ---------------------------------------------------------------------------

export const FORBIDDEN_CONTROL_FIELDS: readonly string[] = [
  "priority",
  "cooldown",
  "score",
  "internal_score",
  "phase",
  "phase_transition",
  "state",
  "state_transition",
  "transition",
  "legal_actions",
  "next_phase",
];

export function findForbiddenControlField(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  for (const key of keys) {
    if (FORBIDDEN_CONTROL_FIELDS.includes(key.toLowerCase())) {
      return key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config schema (API input validation).
// ---------------------------------------------------------------------------

export const seatsSchema = z.object({
  A: modelNameSchema,
  B: modelNameSchema,
  C: modelNameSchema,
  D: modelNameSchema,
  E: modelNameSchema,
  F: modelNameSchema,
  G: modelNameSchema,
});

export const partialConfigSchema = z
  .object({
    seats: seatsSchema.partial().optional(),
    randomize_seats: z.boolean().optional(),
    mock: z.boolean().optional(),
    interrupt_window_ms: z
      .number()
      .int()
      .min(INTERRUPT_WINDOW_MS_MIN)
      .max(INTERRUPT_WINDOW_MS_MAX)
      .optional(),
    evil_fail_probability: z.number().min(0).max(1).optional(),
    seed: z.number().int().nullable().optional(),
    human_seat: playerIdSchema.nullable().optional(),
  })
  .strict();

export const createGameRequestSchema = z
  .object({
    config: partialConfigSchema.optional(),
  })
  .strict();

/** Validated partial config from the create-game request (seats may be partial). */
export type PartialGameConfig = z.infer<typeof partialConfigSchema>;
