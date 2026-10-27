import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentModelId } from "../server/provider-ids.js";
import { modelLevels, modelModes } from "../server/model-levels.js";
import { reasoningLevels } from "../server/profile-options.js";

const optionsSchema = z.object({
  kind: z.literal("agents").optional(),
  agent: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/).optional(),
  agentId: z.string().uuid().optional(),
  memoryKey: z.string().regex(/^agent-[a-zA-Z0-9_-]+$/u).max(100).optional(),
  agentName: z.string().optional(),
  instructions: z.string().optional(),
  modelMode: z.enum(modelModes).optional(),
  level: z.enum(modelLevels).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  reasoningLevel: z.enum(reasoningLevels).optional(),
  longMemory: z.boolean().optional(),
  threadId: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "agents" && !value.agentId)
    ctx.addIssue({ code: "custom", message: "Agents require a bound agent identity." });
  if (!value.agentId) return;
  // memoryKey is set only for the agent's DM. Other agent runs have no long memory.
  if (!value.agent || typeof value.instructions !== "string" ||
    !value.modelMode || !value.level || !value.providerId || !value.model || !value.reasoningLevel)
    ctx.addIssue({ code: "custom", message: "Agent identity and execution policy are required." });
});
export type HempiOptions = z.infer<typeof optionsSchema>;

export function parseHempiOptions(value: unknown): HempiOptions {
  return optionsSchema.parse(value ?? {});
}

export function requireAgentIdentity(options: HempiOptions, threadId: string, model: string): void {
  if (options.agentId && (options.threadId !== threadId || model !== agentModelId(options.agentId)))
    throw new Error("Agent model does not match the bound agent. Open this agent's DM.");
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function prepareOptchatBinding(options: HempiOptions, sessionFile: string, dataDir: string): {
  args: string[];
  label: string;
  bound(): void;
} {
  const profile = options.agent ? options.memoryKey : options.longMemory ? `thread-${options.threadId ?? ""}` : undefined;
  if (!profile) return { args: [], label: options.agentName || options.agent || "Hempi", bound() {} };
  if (!options.agent && (!options.threadId || !/^[a-zA-Z0-9_-]+$/.test(options.threadId))) {
    throw new Error("Long memory requires a valid threadId.");
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const args = ["--optchat-profile", profile, "--optchat-create"];
  const marker = join(dataDir, `binding-${digest(`${sessionFile}\0${profile}`)}.json`);
  if (options.agent) {
    if (typeof options.instructions !== "string") throw new Error("Agent instructions must be a string.");
    const file = join(dataDir, `${profile}.md`);
    if (!existsSync(file) || readFileSync(file, "utf8") !== options.instructions) {
      writeFileSync(file, options.instructions, { encoding: "utf8", mode: 0o600 });
    }
    args.push("--optchat-instructions", file);
  } else if (!existsSync(marker) && existsSync(sessionFile)) {
    args.push("--optchat-import-session", sessionFile);
  }
  return {
    args,
    label: options.agentName || options.agent || "Hempi",
    bound() { writeFileSync(marker, JSON.stringify({ profile, sessionFile }), { mode: 0o600 }); },
  };
}

/**
 * Only an agent's DM holds its memory, and BB runs one DM turn at a time. A busy
 * profile therefore means a stale holder: a crashed turn, or a terminal session
 * on the same profile. Waiting inside turn/start outlives BB's start timeout, so fail now.
 */
export function memoryBusyError(label: string, cause: unknown): Error {
  return new Error(`${label}'s memory is held by another process (a crashed turn or an open terminal session). Close it, then send again.`, { cause });
}
