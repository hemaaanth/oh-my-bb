import { createHash } from "node:crypto";
import { z } from "zod";
import { agentModelId } from "../server/provider-ids.js";

const efforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const effortSchema = z.enum(efforts);
const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  modelId: z.string().regex(/^agent\/[0-9a-f-]+$/u),
  defaultReasoningEffort: effortSchema,
}).strict().refine((agent) => agent.modelId === agentModelId(agent.id));

export const agentsCatalogSchema = z.object({
  kind: z.literal("agents"),
  revision: z.string().regex(/^[0-9a-f]{64}$/u),
  agents: z.array(agentSchema).max(512),
}).strict().refine((catalog) => new Set(catalog.agents.map(({ id }) => id)).size === catalog.agents.length);

export type AgentsCatalogSnapshot = z.infer<typeof agentsCatalogSchema>;

export function agentCatalogSnapshot(profiles: readonly { id: string; name: string; reasoningLevel: string }[]): AgentsCatalogSnapshot {
  const agents = profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    modelId: agentModelId(profile.id),
    defaultReasoningEffort: effortSchema.safeParse(profile.reasoningLevel).success
      ? profile.reasoningLevel as typeof efforts[number]
      : "medium" as const,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const revision = createHash("sha256").update(JSON.stringify(agents)).digest("hex");
  return agentsCatalogSchema.parse({ kind: "agents", revision, agents });
}

// BB's picker title-cases every all-letter word between dashes, so "SDR" shows as "Sdr". A trailing
// invisible word joiner (U+2060) on such a word stops that rewrite and keeps the name as written.
export function pickerDisplayName(name: string) {
  return name.split("-").map((part) => {
    if (!/^[a-z]+$/iu.test(part) || part.toLowerCase() === "gpt") return part;
    return part === part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() ? part : `${part}\u2060`;
  }).join("-");
}

export function agentCatalogModels(snapshot: AgentsCatalogSnapshot) {
  return snapshot.agents.map(({ modelId, name, defaultReasoningEffort }, index) => ({
    id: modelId,
    model: modelId,
    displayName: pickerDisplayName(name),
    description: "Agent",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
    defaultReasoningEffort,
    isDefault: index === 0,
  }));
}
