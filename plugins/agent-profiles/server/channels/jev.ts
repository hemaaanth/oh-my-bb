import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_TIMEOUT_MS = 10_000;

export type AgentChoiceInput = {
  title: string;
  conversation: Array<{
    role: "user" | "assistant";
    name: string;
    text: string;
  }>;
  candidates: Array<{
    id: string;
    name: string;
    handle: string;
    description: string;
  }>;
};

export type AgentChoice = {
  agentId: string | null;
  probability: number;
  confidence: number;
};

export type ReturnDecisionInput = {
  request: { agentName: string; handle: string; text: string };
  results: Array<{
    agentName: string;
    handle: string;
    status: string;
    text: string;
  }>;
  conversationTitle: string;
};

export type ReturnDecision = {
  shouldReturn: boolean;
  probability: number;
  confidence: number;
};

type JevChoiceAnswer = {
  type?: unknown;
  choice?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
};

type JevReturnAnswer = {
  type?: unknown;
  noul?: unknown;
};

export function agentChoiceQuestion(
  candidates: AgentChoiceInput["candidates"],
) {
  return {
    type: "choice" as const,
    instructions:
      "Choose the single channel agent best suited to answer the latest user message.",
    criteria: Object.fromEntries(
      candidates.map((candidate, index) => [
        `a${index}`,
        {
          name: candidate.name,
          handle: `@${candidate.handle.replace(/^@/u, "")}`,
          description: candidate.description,
        },
      ]),
    ),
  };
}

export function returnDecisionQuestion() {
  return {
    type: "noul" as const,
    instructions:
      "Should the requesting agent post a follow-up reply that uses these results, to answer the original request?",
    criteria: {
      true:
        "The results contain useful information, a failure, a cancellation, or a timeout that should be incorporated into a follow-up answer.",
      false:
        "A follow-up would add no useful answer, such as when the exchange is social chatter, an acknowledgment, or only [PASS].",
    },
  };
}

const unit = (value: number) => Math.max(0, Math.min(1, value));

export function interpretAgentChoice(
  candidates: AgentChoiceInput["candidates"],
  answer: JevChoiceAnswer | null | undefined,
): AgentChoice {
  const choice = typeof answer?.choice === "string" ? answer.choice : "";
  const choiceIndex = /^a\d+$/u.test(choice) ? Number(choice.slice(1)) : -1;
  const candidate =
    choiceIndex >= 0 && choiceIndex < candidates.length
      ? candidates[choiceIndex]
      : undefined;
  const probabilities =
    answer?.probabilities && typeof answer.probabilities === "object"
      ? (answer.probabilities as Record<string, unknown>)
      : {};
  const probability = candidate &&
      typeof probabilities[`a${choiceIndex}`] === "number"
    ? unit(probabilities[`a${choiceIndex}`] as number)
    : 0;
  const confidence =
    typeof answer?.confidence === "number" ? unit(answer.confidence) : 0;
  return { agentId: candidate?.id ?? null, probability, confidence };
}

export function interpretReturnDecision(
  answer: JevReturnAnswer | null | undefined,
): ReturnDecision {
  if (
    typeof answer?.noul !== "number" ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1
  )
    throw new Error("Jev omitted the return decision.");
  const probability = answer.noul;
  return {
    shouldReturn: probability > 0.5,
    probability,
    confidence: Math.abs(probability - 0.5) * 2,
  };
}

async function askJev<Answer>(
  apiKey: string,
  state: unknown,
  name: string,
  question: unknown,
  signal: AbortSignal,
): Promise<Answer | undefined> {
  let response: Response | null = null;
  for (const retryDelay of [0, 300, 900]) {
    if (retryDelay) await delay(retryDelay, undefined, { signal });
    const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
    try {
      response = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "jev-latest",
          state,
          questions: { [name]: question },
        }),
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (cause) {
      if (timeout.aborted && !signal.aborted)
        throw new Error("Request timed out");
      throw cause;
    }
    if (response.status !== 429 && response.status !== 529) break;
  }
  if (!response?.ok)
    throw new Error(`Jev returned HTTP ${response?.status ?? "unknown"}`);
  const body = (await response.json()) as {
    answers?: Record<string, Answer | undefined>;
  };
  return body.answers?.[name];
}

export function createJev(
  bb: BbPluginApi,
  apiKey: () => Promise<string | undefined>,
) {
  async function requireKey() {
    const key = (await apiKey())?.trim();
    if (!key) throw new Error("Jev API key missing. Enter it in Agents settings.");
    return key;
  }

  return {
    async chooseAgent(
      input: AgentChoiceInput,
      signal: AbortSignal,
    ): Promise<AgentChoice> {
      const answer = await askJev<JevChoiceAnswer>(
        await requireKey(),
        input,
        "agent",
        agentChoiceQuestion(input.candidates),
        signal,
      );
      const result = interpretAgentChoice(input.candidates, answer);
      const selected = input.candidates.find(
        (candidate) => candidate.id === result.agentId,
      );
      bb.log.info(
        selected
          ? `Jev chose @${selected.handle.replace(/^@/u, "")} for #${input.title} (${Math.round(result.probability * 100)}%, confidence ${Math.round(result.confidence * 100)}%)`
          : `Jev returned no usable channel agent choice for #${input.title}`,
      );
      return result;
    },
    async shouldReturn(
      input: ReturnDecisionInput,
      signal: AbortSignal,
    ): Promise<ReturnDecision> {
      const answer = await askJev<JevReturnAnswer>(
        await requireKey(),
        input,
        "return",
        returnDecisionQuestion(),
        signal,
      );
      return interpretReturnDecision(answer);
    },
  };
}

export type Jev = ReturnType<typeof createJev>;
