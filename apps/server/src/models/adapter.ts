/**
 * Model adapter layer. A single OpenAI-compatible adapter serves all 10 models
 * via the configured gateway (the `model` field selects the model). The
 * controller never knows provider details — it only sees ModelAdapter.
 */

import type {
  GameConfig,
  ModelCallInput,
  ModelCallResult,
  ModelUsage,
  PromptType,
} from "@avalon/shared";
import type { ReasoningEffort, ServerConfig } from "../config.js";
import { MockAdapter } from "./mock.js";
import { parseAction, validateActionShape, safeParseJson } from "./parse.js";
import { buildPrompt } from "./prompts.js";

export interface ModelAdapter {
  readonly id: string;
  generateAction(input: ModelCallInput): Promise<ModelCallResult>;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CallOnceResult {
  content: string;
  usage?: ModelUsage;
  error?: string;
}

interface CallWithRetryResult {
  call: CallOnceResult;
  attempts: number;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

function emptyUsage(): Required<
  Pick<
    ModelUsage,
    | "input_tokens"
    | "output_tokens"
    | "cached_input_tokens"
    | "cache_creation_input_tokens"
    | "cache_read_input_tokens"
  >
> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function addUsage(into: ReturnType<typeof emptyUsage>, usage?: ModelUsage): void {
  if (!usage) return;
  into.input_tokens += usage.input_tokens ?? 0;
  into.output_tokens += usage.output_tokens ?? 0;
  into.cached_input_tokens += usage.cached_input_tokens ?? 0;
  into.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  into.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
}

function temperatureFor(pt: PromptType): number {
  switch (pt) {
    case "vote":
    case "mission":
    case "assassination_decision":
    case "assassination":
      return 0.5;
    default:
      return 0.85;
  }
}

function maxTokensFor(pt: PromptType): number {
  // Generous budgets: reasoning/thinking tokens count against this cap, so it
  // must comfortably exceed reasoning + the JSON answer or the model returns an
  // empty/truncated completion. (Per-call reasoning effort is set by the
  // controller via ModelCallInput.effort.)
  if (pt === "interrupt_intent") return 1200;
  if (pt === "vote" || pt === "mission") return 3000;
  return 4000;
}

/**
 * Adapter for any OpenAI-compatible /chat/completions gateway. Implements
 * parse → schema-validate → one stricter reprompt → (network) retry-once. Game
 * legality + legal fallback are handled by the controller.
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id = "openai-compatible";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly defaultEffort: ReasoningEffort,
  ) {}

  async generateAction(input: ModelCallInput): Promise<ModelCallResult> {
    const { system, user } = buildPrompt(input);
    const effort = input.effort ?? this.defaultEffort;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];

    const started = Date.now();
    let attempts = 0;
    let lastRaw = "";
    const usageAcc = emptyUsage();

    // Attempt 1.
    let call = await this.callOnce(input.model, messages, input.prompt_type, effort);
    attempts += 1;
    addUsage(usageAcc, call.usage);

    if (call.error) {
      // Network/HTTP failure: retry once with the same prompt.
      call = await this.callOnce(input.model, messages, input.prompt_type, effort);
      attempts += 1;
      addUsage(usageAcc, call.usage);
      if (call.error) {
        return {
          raw_text: lastRaw,
          parsed_action: null,
          latency_ms: Date.now() - started,
          error: call.error,
          attempts,
          usage: usageAcc,
        };
      }
    }

    lastRaw = call.content;
    let validation = parseAction(call.content, input.prompt_type);
    if (validation.ok) {
      return {
        raw_text: lastRaw,
        parsed_action: validation.action,
        latency_ms: Date.now() - started,
        attempts,
        usage: usageAcc,
      };
    }

    // Malformed/illegal shape: reprompt once with a stricter instruction.
    const stricter: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: call.content },
      {
        role: "user",
        content:
          `Your previous reply was rejected (${validation.error}). Reply with ONLY a ` +
          `single valid JSON object matching ${input.schema_name}. No prose, no code ` +
          `fences, no extra fields.`,
      },
    ];
    const retry = await this.callOnce(input.model, stricter, input.prompt_type, effort);
    attempts += 1;
    addUsage(usageAcc, retry.usage);

    if (retry.error) {
      return {
        raw_text: lastRaw,
        parsed_action: null,
        latency_ms: Date.now() - started,
        error: retry.error,
        attempts,
        usage: usageAcc,
      };
    }

    lastRaw = retry.content;
    const parsed = safeParseJson(retry.content);
    const v2 =
      parsed === null
        ? { ok: false as const, error: "no JSON object found" }
        : validateActionShape(parsed, input.prompt_type);

    return {
      raw_text: lastRaw,
      parsed_action: v2.ok ? v2.action : null,
      latency_ms: Date.now() - started,
      error: v2.ok ? undefined : v2.error,
      attempts,
      usage: usageAcc,
    };
  }

  private async callOnce(
    model: string,
    messages: ChatMessage[],
    promptType: PromptType,
    effort: ReasoningEffort,
  ): Promise<CallOnceResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: temperatureFor(promptType),
          max_tokens: maxTokensFor(promptType),
          reasoning_effort: effort,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: "", error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          input_tokens_details?: { cached_tokens?: number };
          cached_tokens?: number;
        };
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const cached =
        data.usage?.prompt_tokens_details?.cached_tokens ??
        data.usage?.input_tokens_details?.cached_tokens ??
        data.usage?.cached_tokens;
      return {
        content,
        usage: {
          input_tokens: data.usage?.prompt_tokens,
          output_tokens: data.usage?.completion_tokens,
          cached_input_tokens: cached,
          cache_read_input_tokens: cached,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = msg.includes("abort") || (err as { name?: string })?.name === "AbortError";
      return { content: "", error: isAbort ? `timeout after ${this.timeoutMs}ms` : msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Adapter for the gateway's Anthropic Messages endpoint (/v1/messages). Used for
 * Claude models, where reasoning is driven by extended *thinking* (a token
 * budget) rather than the OpenAI `reasoning_effort` field — which this gateway
 * ignores for Claude. Same parse → validate → reprompt → fallback contract.
 */
export class AnthropicAdapter implements ModelAdapter {
  readonly id = "anthropic";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly defaultEffort: ReasoningEffort,
  ) {}

  async generateAction(input: ModelCallInput): Promise<ModelCallResult> {
    const { system, cacheable_user_prefix, dynamic_user } = buildPrompt(input);
    const budget = thinkingBudgetFor(input.effort ?? this.defaultEffort);
    const started = Date.now();
    let attempts = 0;
    let lastRaw = "";
    const usageAcc = emptyUsage();

    let first = await this.callWithBetaFallback(
      input.model,
      system,
      cacheable_user_prefix,
      dynamic_user,
      input.prompt_type,
      budget,
    );
    let call = first.call;
    attempts += first.attempts;
    addUsage(usageAcc, call.usage);

    if (call.error) {
      const retryCall = await this.callWithBetaFallback(
        input.model,
        system,
        cacheable_user_prefix,
        dynamic_user,
        input.prompt_type,
        budget,
      );
      call = retryCall.call;
      attempts += retryCall.attempts;
      addUsage(usageAcc, call.usage);
      if (call.error) {
        return { raw_text: lastRaw, parsed_action: null, latency_ms: Date.now() - started, error: call.error, attempts, usage: usageAcc };
      }
    }

    lastRaw = call.content;
    const validation = parseAction(call.content, input.prompt_type);
    if (validation.ok) {
      return { raw_text: lastRaw, parsed_action: validation.action, latency_ms: Date.now() - started, attempts, usage: usageAcc };
    }

    // Stricter reprompt as a fresh user turn (avoids echoing thinking blocks).
    const stricterDynamicUser =
      `${dynamic_user}\n\n你上一次的回复被拒绝(${validation.error})。请只输出一个符合 ` +
      `${input.schema_name} 的 JSON 对象,不要任何其他文字、代码块或多余字段。`;
    const strictRetry = await this.callWithBetaFallback(
      input.model,
      system,
      cacheable_user_prefix,
      stricterDynamicUser,
      input.prompt_type,
      budget,
    );
    const retry = strictRetry.call;
    attempts += strictRetry.attempts;
    addUsage(usageAcc, retry.usage);

    if (retry.error) {
      return { raw_text: lastRaw, parsed_action: null, latency_ms: Date.now() - started, error: retry.error, attempts, usage: usageAcc };
    }

    lastRaw = retry.content;
    const parsed = safeParseJson(retry.content);
    const v2 =
      parsed === null
        ? { ok: false as const, error: "no JSON object found" }
        : validateActionShape(parsed, input.prompt_type);
    return {
      raw_text: lastRaw,
      parsed_action: v2.ok ? v2.action : null,
      latency_ms: Date.now() - started,
      error: v2.ok ? undefined : v2.error,
      attempts,
      usage: usageAcc,
    };
  }

  private async callWithBetaFallback(
    model: string,
    system: string,
    cacheableUserPrefix: string,
    dynamicUserContent: string,
    promptType: PromptType,
    budget: number,
  ): Promise<CallWithRetryResult> {
    const first = await this.callOnce(
      model,
      system,
      cacheableUserPrefix,
      dynamicUserContent,
      promptType,
      budget,
      true,
    );
    if (!isInvalidBetaFlagError(first.error)) return { call: first, attempts: 1 };

    const retryWithoutBeta = await this.callOnce(
      model,
      system,
      cacheableUserPrefix,
      dynamicUserContent,
      promptType,
      budget,
      false,
    );
    return { call: retryWithoutBeta, attempts: 2 };
  }

  private async callOnce(
    model: string,
    system: string,
    cacheableUserPrefix: string,
    dynamicUserContent: string,
    promptType: PromptType,
    budget: number,
    usePromptCachingBeta: boolean,
  ): Promise<CallOnceResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const useThinking = budget >= 1024;
      const body: Record<string, unknown> = {
        model,
        // Thinking tokens count toward max_tokens, so it must exceed the budget
        // plus room for the JSON answer.
        max_tokens: (useThinking ? budget : 0) + maxTokensFor(promptType),
        system: [
          {
            type: "text",
            text: `${system}\n\n${cacheableUserPrefix}`,
            cache_control: { type: "ephemeral" },
          } satisfies AnthropicTextBlock,
        ],
        messages: [{ role: "user", content: dynamicUserContent }],
      };
      if (useThinking) {
        // Extended thinking requires temperature unset (defaults to 1).
        body.thinking = { type: "enabled", budget_tokens: budget };
      } else {
        body.temperature = temperatureFor(promptType);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "anthropic-version": "2023-06-01",
      };
      if (usePromptCachingBeta) headers["anthropic-beta"] = "prompt-caching-2024-07-31";

      const res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: "", error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      }

      const data = (await res.json()) as {
        content?: { type: string; text?: string }[];
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      const content = (data.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return {
        content,
        usage: {
          input_tokens: data.usage?.input_tokens,
          output_tokens: data.usage?.output_tokens,
          cache_creation_input_tokens: data.usage?.cache_creation_input_tokens,
          cache_read_input_tokens: data.usage?.cache_read_input_tokens,
          cached_input_tokens: data.usage?.cache_read_input_tokens,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = msg.includes("abort") || (err as { name?: string })?.name === "AbortError";
      return { content: "", error: isAbort ? `timeout after ${this.timeoutMs}ms` : msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isInvalidBetaFlagError(error: string | undefined): boolean {
  return /\binvalid beta flag\b/i.test(error ?? "");
}

/** Map a reasoning-effort tier to a Claude thinking-token budget (min 1024; 0 disables). */
export function thinkingBudgetFor(effort: ReasoningEffort): number {
  switch (effort) {
    case "minimal":
      return 0;
    case "low":
      return 1024;
    case "medium":
      return 2048;
    case "high":
    default:
      return 6000;
  }
}

function isClaudeModel(model: string): boolean {
  return model.startsWith("claude");
}

/**
 * Choose the adapter for a game. Mock when forced/configured. Otherwise a router
 * that sends Claude models to the Anthropic endpoint (extended thinking) and all
 * other models to the OpenAI-compatible endpoint (reasoning_effort).
 */
export function createAdapter(server: ServerConfig, gameConfig: GameConfig): ModelAdapter {
  if (server.forceMock || gameConfig.mock) {
    return new MockAdapter(gameConfig.evil_fail_probability);
  }
  const openai = new OpenAICompatibleAdapter(
    server.gateway.baseUrl,
    server.gateway.apiKey,
    server.modelTimeoutMs,
    server.reasoningEffort,
  );
  const anthropic = new AnthropicAdapter(
    server.gateway.baseUrl,
    server.gateway.apiKey,
    server.modelTimeoutMs,
    server.reasoningEffort,
  );
  return {
    id: "routing",
    generateAction: (input) =>
      (isClaudeModel(input.model) ? anthropic : openai).generateAction(input),
  };
}
