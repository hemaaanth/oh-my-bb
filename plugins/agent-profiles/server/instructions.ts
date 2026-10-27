import type { Profile } from "./contract";

export type InstructionContext =
  | "default"
  | "delegation"
  | "direct"
  | "channel"
  | "mission";

export type AgentDocuments = {
  mission: string;
  // MEMORY.md was retired to MEMORY.legacy.md; the agent moves what still matters, then deletes it.
  legacyMemory: boolean;
};

const CONFIGURE_LIMIT = 4_096;
const SPAWN_LIMIT = 100_000;
const TRUNCATION_MARKER = "… (truncated, use agent_document_read)";

function excerpt(text: string, limit: number) {
  const value = text.trim();
  if (value.length <= limit) return value;
  const contentLimit = limit - TRUNCATION_MARKER.length - 1;
  if (contentLimit <= 0) return TRUNCATION_MARKER.slice(0, limit);
  const candidate = value.slice(0, contentLimit);
  const boundary = candidate.lastIndexOf("\n");
  const prefix = boundary > 0 ? candidate.slice(0, boundary) : candidate;
  return `${prefix.trimEnd()}\n${TRUNCATION_MARKER}`;
}

function framing(agent: Profile, context: InstructionContext) {
  const identity = `You are operating as the saved BB agent profile “${agent.name}” (@${agent.slug}), revision ${agent.revision}.`;
  if (context === "default")
    return `This thread uses @${agent.slug} as BB's default agent profile because no explicit profile was selected.\n\n${identity}`;
  if (context === "delegation")
    return `${identity}\n\nYou are working as a delegated child agent. Complete the bounded task and report concrete results to the parent thread.`;
  if (context === "direct")
    return `${identity}\n\nThe owner started this thread with you directly. Work on their request with your persona and mission.`;
  if (context === "channel")
    return `${identity}\n\nYou are responding as @${agent.slug} in a shared channel. Follow the channel context and your standing mission.`;
  return `${identity}\n\nYou are executing @${agent.slug}'s standing mission. Follow the current mission.`;
}

const TOOL_GUIDANCE = [
  "Use agent_document_read to reload MISSION.md or PERSONA.md.",
  "Your conversation memory keeps what happened across turns. Put facts that other agents and threads need in clasi.",
  "When you learn a lasting lesson about how you should work, update your persona with agent_persona_update and tell the owner what you changed.",
].join(" ");
const LEGACY_MEMORY_GUIDANCE =
  "Your old MEMORY.md is now MEMORY.legacy.md in your home. When you have a quiet moment, move shared facts to clasi and lessons about yourself to your persona, then delete MEMORY.legacy.md.";

function thinBlock(agent: Profile) {
  return [
    `You are operating as the saved BB agent profile “${agent.name}” (@${agent.slug}), revision ${agent.revision}.`,
    agent.instructions ? `## Persona\n${agent.instructions}` : "",
  ].filter(Boolean).join("\n\n");
}

function block(
  agent: Profile,
  context: InstructionContext,
  docs: AgentDocuments,
  caps: { persona: number; mission: number },
) {
  if (agent.kind === "thin") return thinBlock(agent);
  return [
    framing(agent, context),
    agent.instructions
      ? `## Persona\n${excerpt(agent.instructions, caps.persona)}`
      : "",
    `## Mission\n${excerpt(docs.mission, caps.mission)}`,
    TOOL_GUIDANCE,
    docs.legacyMemory ? LEGACY_MEMORY_GUIDANCE : "",
  ].filter(Boolean).join("\n\n");
}

export function assembleInstructions(
  agent: Profile,
  context: InstructionContext,
  docs: AgentDocuments,
) {
  const caps = context === "default"
    ? { persona: 2_400, mission: 1_000 }
    : { persona: 1_800, mission: 1_600 };
  return block(agent, context, docs, caps).slice(0, CONFIGURE_LIMIT);
}

export function spawnPreamble(
  agent: Profile,
  docs: AgentDocuments,
  context: Exclude<InstructionContext, "default">,
) {
  return block(agent, context, docs, {
    persona: agent.instructions.length,
    mission: 24_000,
  }).slice(0, SPAWN_LIMIT);
}
