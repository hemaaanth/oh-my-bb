import type { BbPluginApi, PluginCliRegistration } from "@get-bb/plugin-sdk";
import { z } from "zod";
import scriptsPlugin from "./server.js";
import { scriptsRpcContract } from "./rpc.js";
const preferencesContract = {
  scriptsPreferences: {
    input: z.null(),
    output: z.object({ autoStartServices: z.boolean() }).strict(),
  },
  saveScriptsPreferences: {
    input: z.object({ autoStartServices: z.boolean() }).strict(),
    output: z.object({ autoStartServices: z.boolean() }).strict(),
  },
};
export async function registerScripts(bb: BbPluginApi) {
  let cli!: PluginCliRegistration;
  const read = async () => ({
    autoStartServices:
      (await bb.storage.kv.get<boolean>("scripts:autostart")) ?? true,
  });
  bb.rpc.register(preferencesContract, {
    scriptsPreferences: read,
    saveScriptsPreferences: async (input, context) => {
      if (context.experimental_caller.kind !== "client")
        throw new Error("Use Projects settings");
      await bb.storage.kv.set("scripts:autostart", input.autoStartServices);
      return read();
    },
  });
  const wrapped = new Proxy(bb, {
    get(target, key) {
      if (key === "storage")
        return {
          ...target.storage,
          kv: {
            get: <T>(key: string) => target.storage.kv.get<T>("scripts:" + key),
            set: (key: string, value: unknown) =>
              target.storage.kv.set("scripts:" + key, value),
            delete: (key: string) => target.storage.kv.delete("scripts:" + key),
            list: async (prefix = "") =>
              (await target.storage.kv.list("scripts:" + prefix)).map((key) =>
                key.slice(8),
              ),
          },
        };
      if (key === "settings") return { define: () => ({ get: read }) };
      if (key === "rpc")
        return {
          register(_contract: unknown, handlers: Record<string, unknown>) {
            target.rpc.register(
              scriptsRpcContract,
              Object.fromEntries(
                Object.entries(handlers).map(([name, handler]) => [
                  `scripts_${name}`,
                  handler,
                ]),
              ) as never,
            );
          },
        };
      if (key === "cli")
        return {
          register(value: PluginCliRegistration) {
            cli = value;
          },
        };
      return Reflect.get(target, key);
    },
  });
  scriptsPlugin(wrapped);
  return cli;
}
export { preferencesContract as scriptsPreferencesContract };
