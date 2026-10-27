import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
const behavior = z.enum(["directed", "smart"]);
export const agentPreferencesContract = defineRpcContract({
  agentPreferences: { input: z.null(), output: z.object({ responseBehavior: behavior }) },
  updateAgentPreferences: { input: z.object({ responseBehavior: behavior }).strict(), output: z.object({ responseBehavior: behavior }) },
});
export async function loadAgentPreferences(bb: BbPluginApi) {
  const settings = bb.settings.define({ jevApiKey: { type: "string", label: "Jev API key", secret: true, description: "Choose an agent in Automatic channels and decide whether delegated results need a follow-up." } });
  const key = "response-behavior:v1";
  let saved = await bb.storage.kv.get(key);
  let legacy: ReturnType<typeof bb.settings.define> | undefined;
  if (saved === undefined) {
    legacy = bb.settings.define({ defaultResponseBehavior: { type: "select", label: "New channel response behavior", options: ["directed", "smart"], default: "smart" } });
    const value = (await legacy.get()).defaultResponseBehavior;
    saved = value === "everyone" ? "smart" : value;
    await bb.storage.kv.set(key, behavior.parse(saved));
  }
  let current = behavior.parse(saved);
  let pending = Promise.resolve();
  const update = (value: string) => {
    const next = behavior.parse(value);
    const task = pending.then(async () => {
      if (next === current) return;
      await bb.storage.kv.set(key, next); current = next;
      bb.realtime.publish("agent-preferences", null);
    });
    pending = task.catch(() => {}); return task;
  };
  legacy?.onChange(next => { void update(String(next.defaultResponseBehavior)).catch(() => bb.log.error("Could not preserve channel preference")); });
  bb.onDispose(() => pending);
  bb.rpc.register(agentPreferencesContract, {
    agentPreferences: () => ({ responseBehavior: current }),
    updateAgentPreferences: async (input, context) => {
      if (context.experimental_caller.kind !== "client") throw new Error("Owner client required");
      await update(input.responseBehavior); return { responseBehavior: current };
    },
  });
  return { get: async () => ({ ...await settings.get(), defaultResponseBehavior: current }), setResponseBehavior: update };
}
