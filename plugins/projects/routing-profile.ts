import { createHash } from "node:crypto";
import { z } from "zod";

export const DEFAULT_ROUTING_MODEL = "google/gemini-2.5-flash-lite";

export const generatedRoutingProfileSchema = z.object({
  description: z.string().trim().min(1).max(1_200),
  keywords: z.array(z.string().trim().min(1).max(80)).max(24),
  aliases: z.array(z.string().trim().min(1).max(100)).max(16),
  repositories: z.array(z.string().trim().min(1).max(240)).max(16),
  notFor: z.array(z.string().trim().min(1).max(240)).max(8).default([]),
}).strict();

export type GeneratedRoutingProfile = z.infer<typeof generatedRoutingProfileSchema>;

export interface RoutingProfileEvidence {
  name: string;
  gitRemoteUrl: string | null;
  packageJson: string | null;
  readme: string | null;
  mappedSources: string[];
  taskTitles: string[];
}

function normalizedUnique(values: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/gu, " ").trim();
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= max) break;
  }
  return output;
}

export function normalizeGeneratedRoutingProfile(profile: GeneratedRoutingProfile): GeneratedRoutingProfile {
  return {
    description: profile.description.replace(/\s+/gu, " ").trim(),
    keywords: normalizedUnique(profile.keywords, 24),
    aliases: normalizedUnique(profile.aliases, 16),
    repositories: normalizedUnique(profile.repositories, 16),
    notFor: normalizedUnique(profile.notFor, 8),
  };
}

// Bump when the prompt or output shape changes so generated profiles refresh.
const ROUTING_PROFILE_VERSION = 2;

export function routingEvidenceFingerprint(evidence: RoutingProfileEvidence): string {
  return createHash("sha256").update(JSON.stringify({
    version: ROUTING_PROFILE_VERSION,
    name: evidence.name,
    gitRemoteUrl: evidence.gitRemoteUrl,
    packageJson: evidence.packageJson,
    readme: evidence.readme,
    mappedSources: [...evidence.mappedSources].sort(),
  })).digest("hex");
}

function packageSummary(content: string | null): unknown {
  if (!content) return null;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const dependencies = value.dependencies && typeof value.dependencies === "object"
      ? Object.keys(value.dependencies as Record<string, unknown>).slice(0, 40)
      : [];
    return {
      name: typeof value.name === "string" ? value.name : null,
      description: typeof value.description === "string" ? value.description : null,
      keywords: Array.isArray(value.keywords) ? value.keywords.filter((item): item is string => typeof item === "string").slice(0, 20) : [],
      dependencies,
    };
  } catch {
    return content.slice(0, 4_000);
  }
}

export function routingProfilePrompt(evidence: RoutingProfileEvidence): string {
  return [
    "Create routing metadata for one software project.",
    "The metadata will help choose the right project from a natural-language draft.",
    "A project is the right choice only when the work needs this project's files, code, data, or tools.",
    "Describe what the project is for, who or what it serves, and the work that happens in this repository.",
    "Prefer product and domain language over implementation details.",
    "Keywords should include terms a person may type when asking for work in this project.",
    "Aliases should include product names, abbreviations, and common alternate names.",
    "Do not use a parent product or platform name as an alias or keyword when this project only extends, configures, or integrates with it.",
    "Repositories should contain owner/repository names or source labels that identify this project.",
    "notFor should list requests that mention this project's subject but belong elsewhere or in no project.",
    "For example, if this project builds a tool that people also use for other work, using that tool is not work in this project.",
    "Do not invent facts. Omit weak guesses.",
    "",
    JSON.stringify({
      projectName: evidence.name,
      gitRemoteUrl: evidence.gitRemoteUrl,
      package: packageSummary(evidence.packageJson),
      readme: evidence.readme?.slice(0, 14_000) ?? null,
      mappedTaskSources: evidence.mappedSources.slice(0, 30),
      exampleLinkedTasks: evidence.taskTitles.slice(0, 20),
    }),
  ].join("\n");
}

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: unknown };
};

function responseContent(body: OpenRouterResponse): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.flatMap((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("");
  }
  throw new Error("OpenRouter returned no profile content");
}

export async function requestOpenRouterJson(input: {
  apiKey: string;
  model: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "x-title": "BB project routing profiles",
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0.1,
        max_tokens: input.maxTokens,
        messages: [{ role: "user", content: input.prompt }],
        provider: { require_parameters: true },
        response_format: {
          type: "json_schema",
          json_schema: { name: input.schemaName, strict: true, schema: input.schema },
        },
      }),
    });
    const raw = await response.text();
    let body: OpenRouterResponse;
    try { body = JSON.parse(raw) as OpenRouterResponse; }
    catch { throw new Error(`OpenRouter returned invalid JSON (HTTP ${response.status})`); }
    if (!response.ok) {
      const detail = typeof body.error?.message === "string" ? `: ${body.error.message}` : "";
      throw new Error(`OpenRouter returned HTTP ${response.status}${detail}`);
    }
    return JSON.parse(responseContent(body));
  } finally {
    clearTimeout(timer);
  }
}

export async function generateRoutingProfile(input: {
  apiKey: string;
  model: string;
  evidence: RoutingProfileEvidence;
  fetchImpl?: typeof fetch;
}): Promise<GeneratedRoutingProfile> {
  const content = await requestOpenRouterJson({
    apiKey: input.apiKey,
    model: input.model,
    prompt: routingProfilePrompt(input.evidence),
    schemaName: "project_routing_profile",
    maxTokens: 900,
    fetchImpl: input.fetchImpl,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        description: { type: "string", description: "One to three concise sentences about the project's purpose and the work that belongs in it." },
        keywords: { type: "array", items: { type: "string" }, maxItems: 24 },
        aliases: { type: "array", items: { type: "string" }, maxItems: 16 },
        repositories: { type: "array", items: { type: "string" }, maxItems: 16 },
        notFor: { type: "array", items: { type: "string" }, maxItems: 8, description: "Short phrases describing requests that mention this project but do not need its files." },
      },
      required: ["description", "keywords", "aliases", "repositories", "notFor"],
    },
  });
  return normalizeGeneratedRoutingProfile(generatedRoutingProfileSchema.parse(content));
}
