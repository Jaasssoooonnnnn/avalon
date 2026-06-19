/**
 * Robust extraction + schema validation of model output. Core mechanics never
 * rely on natural-language parsing — only on JSON validated against the shared
 * Zod schemas, with forbidden control-plane fields rejected.
 */

import {
  PROMPT_ALLOWED_ACTIONS,
  PROMPT_SCHEMAS,
  findForbiddenControlField,
  type PlayerAction,
  type PromptType,
} from "@avalon/shared";

/** Strip ```json ... ``` / ``` ... ``` fences if present. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1]!.trim() : trimmed;
}

/**
 * Find the first balanced top-level JSON object in arbitrary text, respecting
 * string literals and escapes. Returns the substring or null.
 */
export function extractFirstJsonObject(text: string): string | null {
  const s = stripFences(text);
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function safeParseJson(text: string): unknown | null {
  const json = extractFirstJsonObject(text);
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export type ShapeValidation =
  | { ok: true; action: PlayerAction }
  | { ok: false; error: string };

/**
 * Validate a parsed object as a schema-legal action for the given prompt type.
 * This checks shape only; game-legality (phase, leader-only, team size, mission
 * membership) is enforced separately by the controller.
 */
export function validateActionShape(
  raw: unknown,
  promptType: PromptType,
): ShapeValidation {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "output was not a JSON object" };
  }
  const forbidden = findForbiddenControlField(raw);
  if (forbidden) {
    return { ok: false, error: `model emitted forbidden control field: ${forbidden}` };
  }
  const schema = PROMPT_SCHEMAS[promptType];
  const res = schema.safeParse(raw);
  if (!res.success) {
    const msg = res.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: msg || "schema validation failed" };
  }
  const action = res.data as PlayerAction;
  if (!PROMPT_ALLOWED_ACTIONS[promptType].includes(action.action)) {
    return {
      ok: false,
      error: `action "${action.action}" is not allowed for ${promptType}`,
    };
  }
  return { ok: true, action };
}

/** Parse raw model text straight to a schema-valid action (or an error). */
export function parseAction(rawText: string, promptType: PromptType): ShapeValidation {
  const parsed = safeParseJson(rawText);
  if (parsed === null) {
    return { ok: false, error: "no JSON object found in model output" };
  }
  return validateActionShape(parsed, promptType);
}
