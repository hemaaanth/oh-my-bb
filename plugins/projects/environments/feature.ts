import { ServiceAccountTokenStore } from "./runtime.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi, ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { environmentCliContract } from "./cli-contract.js";
import { projectEnvironmentContract } from "./project-contract.js";
import environmentPlugin from "./server.js";
import { environmentRpcContract } from "./rpc.js";

type Handler = (input: any, context: ExperimentalPluginRpcHandlerContext) => any;
const preparationMethods = new Set(["prepare", "startPrepare", "preparationStatus", "preparationOutcomeV1", "workspaceSelection", "cleanupPreparation"]);
/** The compatibility ID has no data writer. Projects owns storage and all execution. */
export async function registerEnvironments(bb: BbPluginApi, projectHandlers: Record<string, Handler>, bindings: { get: (id: string) => string | null; set: (id: string, environmentId: string) => void }) {
  const migration = await bb.storage.kv.get("environments:migration:v1");
  const dataDir = bb.server.experimental_dataDir;
  if (dataDir && existsSync(join(dataDir, "plugins", "project-environments", "data.db")) && !migration) {
    throw new Error("Existing project environments must be migrated before Projects can own them. The original data is unchanged.");
  }
  const db = bb.storage.database();
  bb.rpc.register(projectEnvironmentContract, {
    async setProjectEnvironmentToken(input, context) {
      if (context.experimental_caller.kind !== "client") throw new Error("Use the Projects editor");
      const existing = db.prepare("SELECT updated_at FROM runtime_profiles WHERE id=?").get(input.expectedProfileId) as { updated_at: string } | undefined;
      if (bindings.get(input.projectId) !== input.expectedProfileId || existing?.updated_at !== input.expectedUpdatedAt) throw new Error("Project environment changed; reload before saving the token");
      const shared = (db.prepare("SELECT COUNT(*) AS count FROM project_configuration WHERE credential_id=?").get(input.expectedProfileId) as { count: number }).count;
      if (shared > 1 && !input.confirmShared) throw new Error("Confirm this token applies to the shared environment");
      await new ServiceAccountTokenStore(db.name).write(input.expectedProfileId, input.token);
      bb.realtime.publish("project-environments-changed", { projectId: input.projectId });
      return { configured: true as const };
    },
    saveProjectEnvironment(input, context) {
      if (context.experimental_caller.kind !== "client") throw new Error("Use the Projects editor");
      const result = db.transaction(() => {
        if (bindings.get(input.projectId) !== input.expectedProfileId) throw new Error("Project environment changed; reload before saving");
        const existing = input.expectedProfileId ? db.prepare("SELECT * FROM runtime_profiles WHERE id = ?").get(input.expectedProfileId) as { id: string; updated_at: string } | undefined : undefined;
        if (input.expectedProfileId && (!existing || existing.updated_at !== input.expectedUpdatedAt)) throw new Error("Environment changed; reload before saving");
        const shared = existing ? (db.prepare("SELECT COUNT(*) AS count FROM project_configuration WHERE credential_id = ?").get(existing.id) as { count: number }).count : 0;
        if (shared > 1 && !input.confirmShared) throw new Error("This legacy environment is shared; confirm the edit applies to all linked projects");
        const id = existing?.id ?? randomUUID();
        const updatedAt = new Date(Math.max(Date.now(), (Date.parse(existing?.updated_at ?? "") || 0) + 1)).toISOString();
        if (existing) {
          db.prepare("UPDATE runtime_profiles SET name=?, environment_name=?, environment_id=?, account=?, service_account_name=?, updated_at=? WHERE id=?").run(input.name, input.environmentName, input.environmentId, input.account, input.serviceAccountName, updatedAt, id);
        } else {
          db.prepare("INSERT INTO runtime_profiles (id,name,description,environment_name,environment_id,account,service_account_name,capabilities,setup_script,instructions,created_at,updated_at) VALUES (?,?,'',?,?,?,?, '[]','','',?,?)").run(id,input.name,input.environmentName,input.environmentId,input.account,input.serviceAccountName,updatedAt,updatedAt);
          bindings.set(input.projectId, id);
        }
        return { id, updatedAt };
      })();
      runtime.refreshCache(input.projectId, result.id);
      bb.realtime.publish("project-environments-changed", { projectId: input.projectId, profileId: result.id });
      return result;
    },
  });
  const prefix = "environments:";
  const kv = {
    get: <T>(key: string) => bb.storage.kv.get<T>(prefix + key),
    set: (key: string, value: unknown) => bb.storage.kv.set(prefix + key, value),
    delete: (key: string) => bb.storage.kv.delete(prefix + key),
    list: async (filter = "") => (await bb.storage.kv.list(prefix + filter)).map(key => key.slice(prefix.length)),
  };
  const wrapped = new Proxy(bb, {
    get(target, key) {
      if (key === "storage") return { ...target.storage, kv, migrate: () => { /* Applied once by Projects' append-only migration chain. */ } };
      if (key === "cli") return { register(registration: any) {
        target.rpc.register(environmentCliContract, { environment_cli(input, context) {
          if (context.experimental_caller.kind !== "plugin" || context.experimental_caller.pluginId !== "project-environments") throw new Error("Use bb project-env");
          const { argv, ...cliContext } = input;
          return registration.run(argv, cliContext);
        } });
      } };
      if (key === "rpc") return { register(_contract: unknown, handlers: Record<string, Handler>) {
        const exposed = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [`environment_${name}`, (input: unknown, context: ExperimentalPluginRpcHandlerContext) => {
          const caller = context?.experimental_caller;
          if (caller?.kind !== "client" && !(caller?.kind === "plugin" && (caller.pluginId === "project-environments" || caller.pluginId === "sandboxes" && preparationMethods.has(name)))) {
            throw new Error("Use Projects to manage application environments");
          }
          return handler(input, context);
        }]));
        target.rpc.register(environmentRpcContract, exposed as never);
      } };
      if (key === "sdk") return new Proxy(target.sdk, { get(sdk, sdkKey) {
        if (sdkKey !== "plugins") return Reflect.get(sdk, sdkKey);
        return new Proxy(sdk.plugins, { get(plugins, pluginKey) {
          if (pluginKey !== "callRpc") return Reflect.get(plugins, pluginKey);
          return async (request: any) => {
        const local = request.pluginId === "projects" ? projectHandlers[request.method] : undefined;
        if (local) return request.outputSchema.parse(await local(request.input, { experimental_caller: { kind: "plugin", pluginId: "projects" } } as ExperimentalPluginRpcHandlerContext));
        return target.sdk.plugins.callRpc(request);
          };
        } });
      } });
      return Reflect.get(target, key);
    },
  });
  const runtime = await environmentPlugin(wrapped);
}
