import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_ALLOWED_ACTIONS,
  SCHEMA_NAME_BY_PROMPT,
  defaultConfig,
  type ModelCallInput,
} from "@avalon/shared";
import { AnthropicAdapter, thinkingBudgetFor } from "../../apps/server/src/models/adapter";
import { createInitialState } from "../../apps/server/src/game/state";
import { toPublicGameView } from "../../apps/server/src/game/views";
import { IdGen } from "../../apps/server/src/utils/ids";
import { makeRng } from "../../apps/server/src/utils/random";

function modelInput(): ModelCallInput {
  const state = createInitialState("adapter_test", defaultConfig(), new IdGen(), makeRng(1));
  return {
    player_id: "A",
    model: "claude-opus-4-8",
    phase: "interrupt_collect",
    prompt_type: "interrupt_intent",
    private_view: state.players.A.private_view,
    public_view: toPublicGameView(state),
    legal_actions: PROMPT_ALLOWED_ACTIONS.interrupt_intent,
    schema_name: SCHEMA_NAME_BY_PROMPT.interrupt_intent,
    effort: "low",
  };
}

describe("AnthropicAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries without anthropic-beta when the gateway rejects the beta flag", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "InvokeModel ValidationException: invalid beta flag",
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: '{"action":"pass"}' }],
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { status: 200 },
        ),
      );

    const adapter = new AnthropicAdapter("https://gateway.test/v1", "test-key", 1000, "medium");
    const result = await adapter.generateAction(modelInput());

    expect(result.parsed_action).toEqual({ action: "pass" });
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(firstHeaders["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(secondHeaders["anthropic-beta"]).toBeUndefined();
  });
});

describe("thinkingBudgetFor", () => {
  it("maps one tier below high to the medium Claude budget", () => {
    expect(thinkingBudgetFor("high")).toBe(6000);
    expect(thinkingBudgetFor("medium")).toBe(2048);
  });
});
