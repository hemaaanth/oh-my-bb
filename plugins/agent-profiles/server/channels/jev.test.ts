import { describe, expect, it } from "vitest";
import {
  agentChoiceQuestion,
  interpretAgentChoice,
  interpretReturnDecision,
  returnDecisionQuestion,
  type AgentChoiceInput,
} from "./jev";

const agents: AgentChoiceInput["candidates"] = [
  {
    id: "agent-atlas",
    name: "Atlas",
    handle: "atlas",
    description: "Plans architecture and system changes.",
  },
  {
    id: "agent-scribe",
    name: "Scribe",
    handle: "@scribe",
    description: "Writes concise product documentation.",
  },
];

describe("Jev channel agent routing", () => {
  it("builds one choice criterion per agent without a none option", () => {
    expect(agentChoiceQuestion(agents)).toEqual({
      type: "choice",
      instructions:
        "Choose the single channel agent best suited to answer the latest user message.",
      criteria: {
        a0: {
          name: "Atlas",
          handle: "@atlas",
          description: "Plans architecture and system changes.",
        },
        a1: {
          name: "Scribe",
          handle: "@scribe",
          description: "Writes concise product documentation.",
        },
      },
    });
  });

  it("returns only a valid chosen agent and clamps Jev scores", () => {
    expect(
      interpretAgentChoice(agents, {
        type: "choice",
        choice: "a1",
        probabilities: { a0: 0.1, a1: 1.2 },
        confidence: -0.4,
      }),
    ).toEqual({
      agentId: "agent-scribe",
      probability: 1,
      confidence: 0,
    });
    expect(
      interpretAgentChoice(agents, {
        type: "choice",
        choice: "none",
        probabilities: { a0: 0.6 },
        confidence: 0.8,
      }),
    ).toEqual({
      agentId: null,
      probability: 0,
      confidence: 0.8,
    });
  });
});

describe("Jev channel return decisions", () => {
  it("builds one probability question and interprets its confidence", () => {
    expect(returnDecisionQuestion()).toEqual({
      type: "noul",
      instructions:
        "Should the requesting agent post a follow-up reply that uses these results, to answer the original request?",
      criteria: {
        true:
          "The results contain useful information, a failure, a cancellation, or a timeout that should be incorporated into a follow-up answer.",
        false:
          "A follow-up would add no useful answer, such as when the exchange is social chatter, an acknowledgment, or only [PASS].",
      },
    });
    expect(interpretReturnDecision({ type: "noul", noul: 0.8 })).toEqual({
      shouldReturn: true,
      probability: 0.8,
      confidence: 0.6000000000000001,
    });
    expect(interpretReturnDecision({ type: "noul", noul: 0.2 })).toEqual({
      shouldReturn: false,
      probability: 0.2,
      confidence: 0.6,
    });
    expect(() => interpretReturnDecision({ type: "noul" })).toThrow(
      "Jev omitted the return decision.",
    );
  });
});
