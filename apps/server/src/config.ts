/**
 * Server configuration. Real gateway credentials are intentionally provided
 * only through environment variables so public commits do not contain secrets.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReasoningEffort } from "@avalon/shared";

export type { ReasoningEffort };

export interface ServerConfig {
  host: string;
  port: number;
  webOrigin: string | true;
  gateway: {
    baseUrl: string;
    apiKey: string;
  };
  /** When true, every game is forced into mock mode regardless of per-game config. */
  forceMock: boolean;
  /** Per-model request timeout (ms) for real gateway calls. */
  modelTimeoutMs: number;
  /** Persist games to disk (event-sourced) so they survive restarts. */
  persist: boolean;
  /** Directory for persisted game JSON files. */
  dataDir: string;
  /** Reasoning effort passed to the gateway for every model call. */
  reasoningEffort: ReasoningEffort;
}

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

// Default data dir lives at the repo root (data/games), independent of cwd.
const HERE = dirname(fileURLToPath(import.meta.url)); // apps/server/src
const REPO_ROOT = resolve(HERE, "../../..");
const DEFAULT_DATA_DIR = resolve(REPO_ROOT, "data/games");

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadLocalEnv(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(line.slice(eq + 1));
  }
}

loadLocalEnv(resolve(REPO_ROOT, ".env"));

export const config: ServerConfig = {
  host: envStr("HOST", "0.0.0.0"),
  port: envNum("PORT", 4000),
  // CORS: allow any origin in dev unless WEB_ORIGIN is set.
  webOrigin: process.env.WEB_ORIGIN ? process.env.WEB_ORIGIN : true,
  gateway: {
    baseUrl: envStr("GATEWAY_BASE_URL", ""),
    apiKey: envStr("GATEWAY_API_KEY", ""),
  },
  forceMock: envBool("FORCE_MOCK", false),
  modelTimeoutMs: envNum("MODEL_TIMEOUT_MS", 300000),
  persist: envBool("PERSIST", true),
  dataDir: process.env.DATA_DIR ? resolve(REPO_ROOT, process.env.DATA_DIR) : DEFAULT_DATA_DIR,
  reasoningEffort: ((): ReasoningEffort => {
    const v = (process.env.REASONING_EFFORT ?? "medium").toLowerCase();
    return v === "minimal" || v === "low" || v === "medium" || v === "high" ? v : "medium";
  })(),
};
