import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_THREAD_ACTION_GROUPS,
  useRealtime,
  useRpc,
  useSdk,
  type PluginThreadActionDataInput,
  type PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../server/contract";
import { HEMPI_PROVIDER_ID } from "../../server/provider-ids";

type MemoryState = { enabled: boolean | null; busy?: boolean };
type MemoryStates = Record<string, MemoryState | null>;
type LongMemoryData = {
  states: MemoryStates;
  toggle: (threadId: string, enabled: boolean) => Promise<void>;
};

function useLongMemory({ threadIds }: PluginThreadActionDataInput): LongMemoryData {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [states, setStates] = useState<MemoryStates>({});
  const pending = useRef(new Set<string>());

  useEffect(() => {
    const missing = threadIds.filter((id) => !Object.hasOwn(states, id));
    if (!missing.length) return;
    let current = true;
    void Promise.all(missing.map(async (threadId): Promise<[string, MemoryState | null]> => {
      try {
        // SDK 0.6.37's thread action target does not include the provider id.
        const thread = await sdk.threads.get({ threadId });
        if (thread.providerId !== HEMPI_PROVIDER_ID) return [threadId, null];
        try {
          return [threadId, await rpc.call("getLongMemory", { threadId })];
        } catch {
          return [threadId, { enabled: null }];
        }
      } catch {
        return [threadId, null];
      }
    })).then((entries) => {
      if (current) setStates((previous) => ({ ...previous, ...Object.fromEntries(entries) }));
    });
    return () => { current = false; };
  }, [rpc, sdk, states, threadIds]);

  useRealtime("long-memory-changed", useCallback((payload) => {
    if (!payload || typeof payload !== "object") return;
    const { threadId, enabled } = payload as Record<string, unknown>;
    if (typeof threadId !== "string" || typeof enabled !== "boolean") return;
    setStates((previous) => previous[threadId]
      ? { ...previous, [threadId]: { ...previous[threadId], enabled } }
      : previous);
  }, []));

  const toggle = useCallback(async (threadId: string, enabled: boolean) => {
    if (pending.current.has(threadId)) return;
    pending.current.add(threadId);
    setStates((previous) => ({ ...previous, [threadId]: { enabled, busy: true } }));
    try {
      const result = await rpc.call("setLongMemory", { threadId, enabled: !enabled });
      setStates((previous) => ({ ...previous, [threadId]: result }));
    } catch (error) {
      setStates((previous) => ({ ...previous, [threadId]: { enabled } }));
      toast.error(error instanceof Error ? error.message : "Unable to change long memory.");
    } finally {
      pending.current.delete(threadId);
    }
  }, [rpc]);

  return { states, toggle };
}

export const longMemoryAction: PluginThreadActionRegistration<LongMemoryData> = {
  id: "long-memory",
  title: "Long memory",
  icon: "Brain",
  group: experimental_THREAD_ACTION_GROUPS.settings,
  useData: useLongMemory,
  item: ({ thread, data }) => {
    const state = data.states[thread.id];
    if (!state) return null;
    return {
      label: state.enabled === null ? "Long memory" : `Long memory: ${state.enabled ? "on" : "off"}`,
      detail: state.enabled === null ? "Unable to load long memory." : undefined,
      icon: "Brain",
      disabled: state.enabled === null || state.busy,
      run: () => state.enabled === null ? undefined : data.toggle(thread.id, state.enabled),
    };
  },
};
