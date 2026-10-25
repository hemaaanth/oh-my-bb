import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract.js";
import { migratedSecurityRecipe } from "./recipes/security-tools/recipe.js";
import { setupDigest, setupPreviewSchema, setupProfileSchema, setupRecipeSchema, type SetupPreview } from "./setup-contract.js";

const KEY = "agent-setup:v1";
const LEGACY_KEY = "security-tools-agents";
const oldProviders = ["sandbox-daytona", "sandbox-modal", "sandbox-e2b", "sandbox-box", "sandbox-freestyle", "sandbox-nirvana"];
const bindingSchema = z.discriminatedUnion("source", [
  z.object({ profileId: z.string().uuid(), source: z.literal("workspace"), name: z.string(), environmentId: z.string(), hostId: z.string(), workspacePath: z.string(), digest: z.string() }).strict(),
  z.object({ profileId: z.string().uuid(), source: z.literal("recipe"), recipeId: z.string(), allowedProviders: z.array(z.string()) }).strict(),
]);
const stateSchema = z.object({ bindings: z.array(bindingSchema).max(1_000), recipes: z.record(z.string(), setupRecipeSchema) }).strict();
type State = z.infer<typeof stateSchema>;

export function registerAgentSetup(bb: BbPluginApi, readPreview: (environmentId: string) => Promise<SetupPreview>) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  let migration: Promise<void> | undefined;
  let changes = Promise.resolve();
  async function migrate() {
    migration ??= (async () => {
      const existing = await bb.storage.kv.get(KEY);
      if (existing === null || existing === undefined) {
        const ids = z.array(z.string().uuid()).max(1_000).parse(await bb.storage.kv.get(LEGACY_KEY) ?? []);
        const recipeId = setupDigest(migratedSecurityRecipe);
        await bb.storage.kv.set(KEY, {
          bindings: ids.map(profileId => ({ profileId, source: "recipe", recipeId, allowedProviders: oldProviders })),
          recipes: ids.length ? { [recipeId]: migratedSecurityRecipe } : {},
        });
      } else {
        stateSchema.parse(existing);
      }
      await bb.storage.kv.delete(LEGACY_KEY);
    })();
    await migration;
  }
  async function state() { await migrate(); return stateSchema.parse(await bb.storage.kv.get(KEY)); }
  function view(value: State) {
    return { bindings: value.bindings.map(binding => ({
      profileId: binding.profileId, source: binding.source,
      name: binding.source === "recipe" ? value.recipes[binding.recipeId]?.name ?? "Missing recipe" : binding.name,
      workspacePath: binding.source === "workspace" ? binding.workspacePath : null,
    })) };
  }
  function mutate(update: (value: State) => State) {
    const result = changes.then(async () => {
      const next = stateSchema.parse(update(await state()));
      const used = new Set(next.bindings.filter(binding => binding.source === "recipe").map(binding => binding.recipeId));
      next.recipes = Object.fromEntries(Object.entries(next.recipes).filter(([id]) => used.has(id)));
      await bb.storage.kv.set(KEY, next);
      return view(next);
    });
    changes = result.then(() => {}, () => {});
    return result;
  }
  const profiles = () => bb.sdk.plugins.callRpc({ pluginId: "agent-profiles", method: "listProfiles", input: null, outputSchema: z.array(setupProfileSchema) });
  async function enable(profileId: string, environmentId: string, digest: string) {
    if (!(await profiles()).some(profile => profile.id === profileId)) throw new Error("Choose an existing agent");
    const preview = setupPreviewSchema.parse(await readPreview(environmentId));
    if (preview.digest !== digest) throw new Error("Setup changed. Review it again before enabling it.");
    return mutate(value => ({ ...value, bindings: [
      ...value.bindings.filter(binding => binding.profileId !== profileId),
      { profileId, source: "workspace", name: preview.recipe.name, environmentId, hostId: preview.hostId, workspacePath: preview.workspacePath, digest },
    ] }));
  }
  const remove = (profileId: string) => mutate(value => ({ ...value, bindings: value.bindings.filter(binding => binding.profileId !== profileId) }));
  async function workspaceForThread(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("This thread has no workspace");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.status !== "ready" || !environment.path) throw new Error("The setup workspace is not ready");
    return environment;
  }
  bb.providers.experimental_contributeEnv("agents", async ({ threadId, hostId }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => {
        const saved = await state();
        if (!saved.bindings.length) return [];
        let providerId: string | null | undefined;
        const machineProvider = async () => {
          if (providerId === undefined) providerId = (await bb.sdk.hosts.get({ hostId })).machineProviderId ?? null;
          return providerId;
        };
        if (saved.bindings.every(binding => binding.source === "recipe")) {
          const provider = await machineProvider();
          if (!provider || !saved.bindings.some(binding => binding.source === "recipe" && binding.allowedProviders.includes(provider))) return [];
        }
        const context = await bb.sdk.plugins.callRpc({
          pluginId: "agent-profiles", method: "catalogContextForThread", input: { threadId },
          outputSchema: z.object({ profileId: z.string().uuid().nullable(), bound: z.boolean() }),
        });
        if (!context.bound) return [];
        const binding = saved.bindings.find(value => value.profileId === context.profileId);
        if (!binding) return [];
        if (binding.source === "recipe") {
          const provider = await machineProvider();
          if (!provider || !binding.allowedProviders.includes(provider)) return [];
        }
        const environment = await workspaceForThread(threadId);
        if (environment.hostId !== hostId) throw new Error("Agent setup host does not match its workspace");
        let recipe;
        if (binding.source === "recipe") {
          recipe = saved.recipes[binding.recipeId];
          if (!recipe) throw new Error("The approved setup recipe is missing");
        } else {
          if (binding.hostId !== hostId || binding.workspacePath !== environment.path) throw new Error("Agent workspace changed. Review setup for this location first.");
          const preview = await readPreview(environment.id);
          if (preview.digest !== binding.digest) throw new Error("Agent setup changed. Review it again before running a turn.");
          recipe = preview.recipe;
        }
        // Stage only inside Core's five-second hook; Agents waits outside it.
        const staged = await host.call("stage_setup", { cwd: environment.path!, recipe }, { hostId, timeoutMs: 3_000 });
        return [
          { name: "AGENT_SETUP_SCRIPT", value: staged.setupScript, reason: "Approved setup before the agent prompt" },
          ...Object.entries(staged.env).map(([name, value]) => ({ name, value, reason: "Approved agent setup environment" })),
        ];
      })(), (() => {
        const { promise, reject } = Promise.withResolvers<never>();
        timer = setTimeout(() => reject(new Error("Agent setup staging timed out")), 3_500);
        return promise;
      })()]);
    } catch (error) {
      return [{ name: "AGENT_SETUP_ERROR", value: `Agent setup failed: ${error instanceof Error ? error.message.slice(-1_000) : String(error).slice(-1_000)}`, reason: "Required setup failed" }];
    } finally { clearTimeout(timer); }
  });
  return {
    async prepare(threadId: string, signal?: AbortSignal) {
      const environment = await workspaceForThread(threadId);
      const preview = await readPreview(environment.id);
      return host.call("run_setup", { cwd: environment.path!, recipe: preview.recipe }, { hostId: environment.hostId, timeoutMs: 600_000, signal });
    },
    async cli(argv: string[], threadId?: string) {
      if (argv[1] === "list") return { exitCode: 0, stdout: `${JSON.stringify(view(await state()))}\n` };
      if (!["enable", "disable"].includes(argv[1] ?? "") || !argv[2]) throw new Error("Usage: bb workspace-scripts agent-setup <list|enable <agent>|disable <agent>>");
      const name = argv[2]!.replace(/^@/u, "");
      const saved = await state();
      const byId = saved.bindings.find(binding => binding.profileId === name);
      if (argv[1] === "disable" && byId) return { exitCode: 0, stdout: `${JSON.stringify(await remove(byId.profileId))}\n` };
      const matches = (await profiles()).filter(profile => [profile.id, profile.slug, profile.name].includes(name));
      if (matches.length !== 1) throw new Error("Choose an agent by UUID or unique slug");
      if (argv[1] === "disable") return { exitCode: 0, stdout: `${JSON.stringify(await remove(matches[0]!.id))}\n` };
      if (!threadId) throw new Error("Enable setup from the workspace's BB thread");
      const environment = await workspaceForThread(threadId);
      const preview = await readPreview(environment.id);
      return { exitCode: 0, stdout: `${JSON.stringify(await enable(matches[0]!.id, environment.id, preview.digest))}\n` };
    },
  };
}
