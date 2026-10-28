import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fleetContract, FLEET_CHANNEL } from "./fleet-contract";
import { FleetEngine } from "./fleet-engine";

const MAX_DETAIL_CHARS = 8_000;
function bounded(value: unknown): { text: string | null; size: number | null } {
  if (value === null || value === undefined) return { text: null, size: null };
  const raw = JSON.stringify(value);
  if (raw === undefined) return { text: null, size: null };
  const size = Buffer.byteLength(raw, "utf8");
  return { text: raw.length > MAX_DETAIL_CHARS ? `${raw.slice(0, MAX_DETAIL_CHARS)}… [${size} bytes originally]` : raw, size };
}

export function registerFleet(bb: BbPluginApi): FleetEngine {
  const engine = new FleetEngine(() => bb.server.experimental_dataDir, (progress) => bb.realtime.publish(FLEET_CHANNEL, progress));
  bb.rpc.register(fleetContract, {
    traces_fleet_start: (input) => engine.start(input),
    traces_fleet_status: ({ jobId }) => engine.snapshot(jobId),
    traces_fleet_cancel: ({ jobId }) => engine.cancel(jobId),
    traces_fleet_detail: async ({ threadId, seq, reveal }) => {
      const events = await bb.sdk.threads.events.list({ threadId, afterSeq: String(seq - 1), limit: "1" });
      const event = events[0];
      if (!event || event.seq !== seq) throw new Error("Event not found in this thread.");
      const data = event.data as Record<string, unknown>;
      const item = data.item && typeof data.item === "object" ? data.item as Record<string, unknown> : null;
      const input = bounded(item ? { type: item.type, tool: item.tool, arguments: item.arguments,
        command: item.command, path: item.path, changes: item.changes } : data);
      const output = bounded(item ? item.result ?? item.aggregatedOutput ?? item.resultText ?? item.error ?? null : null);
      return { threadId, seq, type: event.type, at: event.createdAt,
        input: input.text === null ? null : reveal ? input.text : "[hidden; select Reveal sensitive data]",
        output: output.text === null ? null : reveal ? output.text : "[hidden; select Reveal sensitive data]",
        inputSize: input.size, outputSize: output.size };
    },
  });
  bb.events.on("experimental_thread.events", ({ thread }) => engine.onThreadEvent(thread.id));
  bb.events.on("thread.created", ({ thread }) => engine.onThreadEvent(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => engine.onThreadEvent(thread.id));
  bb.events.on("experimental_thread.parentChanged", ({ thread }) => engine.onThreadEvent(thread.id));
  bb.onDispose(() => engine.dispose());
  return engine;
}
