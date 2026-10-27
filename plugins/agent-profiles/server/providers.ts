import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { hempiProviderDeclaration } from "../provider/declaration";
import { agentCatalogModels, agentCatalogSnapshot } from "../provider/agent-catalog";
import type { Store } from "./channels/store";
import type { Profile } from "./contract";
import { AGENTS_PROVIDER_ID, HEMPI_PROVIDER_ID, profileIdFromAgentModel } from "./provider-ids";
import { memoryHostContract } from "../provider/memory-contract";
import { createAgentMemoryService } from "./agent-memory";
import type { AgentInbox } from "./inbox";

const LONG_MEMORY_KEY = "long-memory:";
/** Plugin routes are mounted under the plugin's API prefix, not at the server root. */
export const AGENT_MEMORY_SERVER_PATH = "/api/v1/plugins/agent-profiles/http/memory";

export interface AgentProviders {
  reconcile(profiles: readonly Profile[]): void;
  getLongMemory(input: { threadId: string }): Promise<{ enabled: boolean }>;
  setLongMemory(input: { threadId: string; enabled: boolean }): Promise<{ enabled: boolean }>;
  dispose(): void;
}

export async function createAgentProviders(bb: BbPluginApi, db: Database.Database, channels: Store, inbox: AgentInbox): Promise<AgentProviders> {
  const profilesById = new Map<string, Profile>();
  const binding = db.prepare("SELECT profile_id AS profileId FROM thread_bindings WHERE thread_id = ?");
  const dm = db.prepare("SELECT 1 FROM agent_dms WHERE thread_id = ? AND profile_id = ?");
  // Only the agent's permanent DM holds its long memory. Tasks, sequence steps, and
  // channel turns run without it, so any number of them can run at once.
  const isDm = (threadId: string, profile: Profile) => Boolean(dm.get(threadId, profile.id));
  function boundProfile(threadId: string): Profile {
    const id = (binding.get(threadId) as { profileId: string } | undefined)?.profileId
      ?? channels.byThread(threadId)?.agentId;
    const profile = id && profilesById.get(id);
    if (!profile) throw new Error("Open this agent's DM: thread has no bound agent identity.");
    return profile;
  }
  function agentOptions(threadId: string, model: string) {
    const profile = boundProfile(threadId);
    if (profileIdFromAgentModel(model) !== profile.id)
      throw new Error("Agent model does not match the bound agent. Open this agent's DM.");
    return {
      threadId, agentId: profile.id, agent: profile.slug,
      ...(isDm(threadId, profile) ? { memoryKey: profile.memoryKey } : {}),
      agentName: profile.name, instructions: profile.instructions,
      modelMode: profile.modelMode, level: profile.level, providerId: profile.providerId,
      model: profile.model, reasoningLevel: profile.reasoningLevel,
    };
  }
  const memory = createAgentMemoryService({
    host: bb.hosts.experimental_client({ contract: memoryHostContract }),
    primaryHostId: async () => (await bb.sdk.system.config()).primaryHostId,
    info: (message) => bb.log.info(message),
  });
  bb.http.route("POST", "/memory", (context) => memory.handle(context.req.raw), { auth: "none" });
  const longMemory = new Set<string>();
  for (const key of await bb.storage.kv.list(LONG_MEMORY_KEY)) {
    if (await bb.storage.kv.get(key) === true)
      longMemory.add(key.slice(LONG_MEMORY_KEY.length));
  }
  const hempi = bb.providers.register({
    ...hempiProviderDeclaration(),
    deriveProviderOptions: ({ threadId }) => ({ threadId, longMemory: longMemory.has(threadId) }),
  });
  let agentsCatalog: { snapshot: string; dispose(): void } | undefined;
  bb.providers.experimental_contributeEnv(AGENTS_PROVIDER_ID, async ({ threadId, hostId }) => {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.providerId !== AGENTS_PROVIDER_ID || thread.deletedAt !== null)
      throw new Error("Agent memory requires a live Agents thread.");
    const profile = boundProfile(threadId);
    if (!isDm(threadId, profile)) return [];
    const cap = await memory.issue({ profile: profile.memoryKey, instructions: profile.instructions, threadId, hostId });
    const reports = profile.kind === "full" ? inbox.take(profile.id, threadId) : null;
    return [
      { name: "AGENT_MEMORY_URL", value: { serverPath: AGENT_MEMORY_SERVER_PATH }, reason: "Authoritative agent memory" },
      { name: "AGENT_MEMORY_KEY", value: cap.key, reason: "Per-turn memory capability" },
      { name: "AGENT_MEMORY_SECRET", value: cap.secret, reason: "Per-turn memory signature" },
      { name: "AGENT_MEMORY_PROFILE", value: cap.profile, reason: "Shared agent profile" },
      { name: "AGENT_MEMORY_MODE", value: cap.mode, reason: "Resolved provider host identity" },
      ...(reports ? [{ name: "AGENT_INBOX", value: reports, reason: "Work this agent did outside its DM" }] : []),
    ];
  });

  function reconcile(profiles: readonly Profile[]) {
    profilesById.clear();
    for (const profile of profiles) profilesById.set(profile.id, profile);
    // Hidden agents stay out of the picker. Their turns still resolve through profilesById.
    const catalog = agentCatalogSnapshot(profiles.filter((profile) => profile.showInSidebar));
    if (agentsCatalog?.snapshot !== catalog.revision) {
      agentsCatalog?.dispose();
      const registration = bb.providers.register({
        ...hempiProviderDeclaration(),
        id: AGENTS_PROVIDER_ID,
        displayName: "Agents",
        models: { ...(catalog.agents.length ? { fallback: agentCatalogModels(catalog) } : {}) },
        experimental_bridgeOptions: catalog,
        deriveProviderOptions: ({ threadId, model }) => agentOptions(threadId, model),
      });
      agentsCatalog = { snapshot: catalog.revision, dispose: () => registration.dispose() };
    }
  }

  async function assertHempi(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.providerId !== HEMPI_PROVIDER_ID)
      throw new Error("Long memory can only be changed on a plain Hempi thread. Agent providers are always on.");
  }

  return {
    reconcile,
    async getLongMemory({ threadId }: { threadId: string }) {
      await assertHempi(threadId);
      return { enabled: longMemory.has(threadId) };
    },
    async setLongMemory({ threadId, enabled }: { threadId: string; enabled: boolean }) {
      await assertHempi(threadId);
      await bb.storage.kv.set(`${LONG_MEMORY_KEY}${threadId}`, enabled);
      if (enabled) longMemory.add(threadId);
      else longMemory.delete(threadId);
      bb.realtime.publish("long-memory-changed", { threadId, enabled });
      return { enabled };
    },
    dispose() {
      memory.dispose();
      profilesById.clear();
      hempi.dispose();
      agentsCatalog?.dispose();
    },
  };
}

