import { describe, expect, it } from "vitest";
import {
  PROMPT_ALLOWED_ACTIONS,
  PROMPT_SCHEMAS,
  playerActionSchema,
} from "@avalon/shared";

describe("player action schema", () => {
  it("accepts every legal action shape", () => {
    const valid = [
      { action: "pass" },
      { action: "request_interrupt", target: "D", speech: "challenge" },
      { action: "withdraw_interrupt", request_id: "req_1" },
      { action: "speak", target: null, speech: "hello", memo: "private note" },
      { action: "propose_team", team: ["A", "B"], speech: "go", memo: "private plan" },
      { action: "vote", approve: true, memo: "private vote reason" },
      { action: "mission_card", card: "fail", memo: "private card reason" },
      { action: "assassinate", target: "A", speech: "merlin", memo: "private read" },
    ];
    for (const v of valid) expect(playerActionSchema.safeParse(v).success).toBe(true);
  });

  it("rejects malformed actions", () => {
    expect(playerActionSchema.safeParse({ action: "nope" }).success).toBe(false);
    expect(playerActionSchema.safeParse({ action: "vote" }).success).toBe(false); // missing approve
    expect(playerActionSchema.safeParse({ action: "propose_team", team: [] }).success).toBe(false);
    expect(playerActionSchema.safeParse({ action: "mission_card", card: "maybe" }).success).toBe(false);
    expect(playerActionSchema.safeParse({ action: "assassinate", target: "Z" }).success).toBe(false);
  });

  it("maps prompt types to allowed actions", () => {
    expect(PROMPT_ALLOWED_ACTIONS.vote).toEqual(["vote"]);
    expect(PROMPT_ALLOWED_ACTIONS.mission).toEqual(["mission_card"]);
    expect(PROMPT_ALLOWED_ACTIONS.assassination_decision).toEqual(["speak", "assassinate"]);
    expect(PROMPT_ALLOWED_ACTIONS.leader_discussion).toEqual(["speak", "propose_team"]);
    expect(PROMPT_ALLOWED_ACTIONS.full_speech).toEqual(["speak"]);
    expect(PROMPT_ALLOWED_ACTIONS.full_speech_optional).toEqual(["speak", "pass"]);
    expect(PROMPT_ALLOWED_ACTIONS.interrupt_intent).toContain("request_interrupt");
    expect(PROMPT_SCHEMAS.leader_proposal.safeParse({ action: "propose_team", team: ["A", "B"] }).success).toBe(true);
    expect(PROMPT_SCHEMAS.leader_discussion.safeParse({ action: "speak", speech: "先听意见" }).success).toBe(true);
    expect(PROMPT_SCHEMAS.leader_discussion.safeParse({ action: "propose_team", team: ["A", "B"] }).success).toBe(true);
    expect(PROMPT_SCHEMAS.full_speech.safeParse({ action: "propose_team", team: ["A", "B"] }).success).toBe(false);
    // full_speech_optional accepts both speak and pass, but not propose_team.
    expect(PROMPT_SCHEMAS.full_speech_optional.safeParse({ action: "speak", speech: "我说两句" }).success).toBe(true);
    expect(PROMPT_SCHEMAS.full_speech_optional.safeParse({ action: "pass" }).success).toBe(true);
    expect(PROMPT_SCHEMAS.full_speech_optional.safeParse({ action: "propose_team", team: ["A", "B"] }).success).toBe(false);
    // A plain full_speech must NOT accept a pass (round-2+ speech is mandatory).
    expect(PROMPT_SCHEMAS.full_speech.safeParse({ action: "pass" }).success).toBe(false);
    expect(PROMPT_SCHEMAS.assassination_decision.safeParse({ action: "assassinate", target: "A" }).success).toBe(true);
    expect(PROMPT_SCHEMAS.vote.safeParse({ action: "speak", speech: "x" }).success).toBe(false);
  });
});
