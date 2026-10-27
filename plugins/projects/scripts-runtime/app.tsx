import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_copyToClipboard,
  useRealtime,
  useRpc,
  type BbNavigate,
  type PluginThreadActionChoice,
  type PluginThreadActionDataInput,
  type PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { InspectResult, ScriptActionView } from "./server";
import type { scriptsRpcContract as rpcContract } from "./rpc";
const SCRIPTS_ICON = "projects/scripts";
import "./app.css";

function actionStatus(action: ScriptActionView) {
  switch (action.status) {
    case "not-run": return "";
    case "starting": return "starting";
    case "running": return "running";
    case "disconnected": return "disconnected";
    case "unknown": return "state unknown";
    case "exited":
      if (action.closeReason && action.closeReason !== "process-exit") return "stopped";
      if (action.type === "service") return action.exitCode === null ? "exited" : `exited (${action.exitCode})`;
      if (action.exitCode === null) return "exited";
      return action.exitCode === 0 ? "last passed" : `failed (${action.exitCode})`;
  }
}

function actionLabel(action: ScriptActionView) {
  const active = action.status === "running" || action.status === "starting";
  const operation = action.type === "service" ? active ? "Stop" : "Start" : "Run";
  const status = actionStatus(action);
  const port = action.port === null ? "" : action.portState === "listening"
    ? ` · :${action.port} listening` : action.portState === "closed"
      ? ` · :${action.port} not listening` : ` · :${action.port}${action.portState === "unknown" ? " unchecked" : ""}`;
  return `${operation} ${action.name}${status ? ` · ${status}` : ""}${port}`;
}

type ScriptsData = {
  snapshots: Record<string, InspectResult>;
  busy: ReadonlySet<string>;
  execute(threadId: string, value: string, navigate: BbNavigate): Promise<void>;
};

function useScripts({ threadIds }: PluginThreadActionDataInput): ScriptsData {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshots, setSnapshots] = useState<Record<string, InspectResult>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Set<string>());
  const visible = useRef(threadIds);
  const current = useRef(snapshots);
  const mounted = useRef(true);
  const sequence = useRef(0);
  visible.current = threadIds;
  current.current = snapshots;
  const requests = useRef(new Map<string, number>());
  const threadIdsKey = JSON.stringify(threadIds);

  const refresh = useCallback(async (ids: readonly string[]) => {
    const request = ++sequence.current;
    const next: Record<string, InspectResult> = {};
    for (const id of ids) requests.current.set(id, request);
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      try {
        Object.assign(next, await rpc.call("scripts_inspectMany", { threadIds: batch }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const id of batch) next[id] = { available: false, message };
      }
    }
    if (mounted.current) {
      setSnapshots(previous => ({
        ...previous,
        ...Object.fromEntries(Object.entries(next).filter(([id]) => requests.current.get(id) === request)),
      }));
    }
  }, [rpc]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requests.current.clear(); };
  }, []);

  useEffect(() => {
    if (!visible.current.length) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      const active = visible.current.filter(id => {
        const snapshot = current.current[id];
        return snapshot?.available && snapshot.actions.some(action =>
          action.status === "running" || action.status === "starting" ||
          action.status === "disconnected" || action.status === "unknown");
      });
      if (active.length) await refresh(active);
      if (!disposed) timer = window.setTimeout(poll, 3_000);
    };
    void refresh(visible.current).then(() => {
      if (!disposed) timer = window.setTimeout(poll, 3_000);
    });
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [threadIdsKey, refresh]);

  useRealtime("workspace-scripts", useCallback(() => {
    if (visible.current.length) void refresh(visible.current);
  }, [refresh]));

  const execute = useCallback(async (threadId: string, value: string, navigate: BbNavigate) => {
    if (pending.current.has(threadId)) return;
    if (value === "refresh") { await refresh([threadId]); return; }
    if (value.startsWith("output:")) {
      const command = `bb terminal output ${value.slice(7)}`;
      if (await experimental_copyToClipboard({ text: command })) toast.success("Output command copied.");
      else toast.error(`Copy failed. Run: ${command}`);
      return;
    }
    pending.current.add(threadId);
    setBusy(new Set(pending.current));
    try {
      if (value.startsWith("run:")) {
        const result = await rpc.call("scripts_run", { threadId, actionId: value.slice(4) });
        const opened = !result.service && await navigate.experimental_openTerminal({ terminalId: result.terminalId });
        if (!opened) toast.success(`${result.title} ${result.reused ? "is already running" : "started"}. Copy its output command from Scripts.`);
      } else if (value.startsWith("stop:")) {
        const result = await rpc.call("scripts_stopService", { threadId, actionId: value.slice(5) });
        toast.success(result.stopped ? "Service stopped." : "Service is not running.");
      } else if (value === "setup" || value === "teardown") {
        const result = await rpc.call("scripts_runHook", { threadId, phase: value });
        if (!await navigate.experimental_openTerminal({ terminalId: result.terminalId })) {
          toast.success(`${result.title} started. Read output with: bb terminal output ${result.terminalId}`);
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current.delete(threadId);
      if (mounted.current) setBusy(new Set(pending.current));
      await refresh([...new Set([threadId, ...visible.current])]);
    }
  }, [rpc, refresh]);

  return { snapshots, busy, execute };
}

const scriptsAction: PluginThreadActionRegistration<ScriptsData> = {
  id: "scripts",
  title: "Scripts",
  icon: SCRIPTS_ICON,
  group: "machine",
  useData: useScripts,
  item: ({ thread, data, navigate }) => {
    const snapshot = data.snapshots[thread.id];
    const choices: PluginThreadActionChoice[] = [];
    let hint = "Add commands to bb.json.";
    if (!snapshot) {
      choices.push({ id: "loading", label: "Loading scripts…", disabled: true });
    } else if (!snapshot.available) {
      choices.push({ id: "unavailable", label: snapshot.message, disabled: true });
    } else {
      for (const action of snapshot.actions) {
        const active = action.status === "running" || action.status === "starting";
        const uncertain = action.status === "disconnected" || action.status === "unknown";
        choices.push({
          id: `${action.type === "service" && active ? "stop" : "run"}:${action.id}`,
          label: actionLabel(action),
          icon: action.type === "service" && active ? "Square" : "Play",
          disabled: uncertain || (action.type === "command" && active),
        });
        if (action.terminalId) {
          choices.push({ id: `output:${action.terminalId}`, label: `Copy ${action.name} output command`, icon: "Copy" });
        }
      }
      if (snapshot.setup) choices.push({ id: "setup", label: "Run workspace setup", icon: "Play" });
      if (snapshot.teardown) choices.push({ id: "teardown", label: "Run workspace teardown", icon: "Play" });
      if (!choices.length) {
        choices.push({ id: "empty", label: "No scripts declared in this checkout", disabled: true });
      } else if (snapshot.actions.some(action => action.status === "unknown" || action.status === "disconnected")) {
        hint = "Reconnect, then refresh status.";
      } else {
        hint = snapshot.manifestFile === "paseo.json" ? "Using paseo.json."
          : snapshot.manifestFile ? "From bb.json."
            : "BB runs lifecycle hooks automatically.";
      }
    }
    choices.push({ id: "refresh", label: "Refresh status", icon: "projects/refresh" });
    return {
      label: "Scripts",
      icon: SCRIPTS_ICON,
      disabled: data.busy.has(thread.id),
      choices: { heading: "Scripts", hint, items: choices },
      run: async ({ value }) => {
        if (value && choices.some(choice => choice.id === value && !choice.disabled)) {
          await data.execute(thread.id, value, navigate);
        }
      },
    };
  },
};

export function registerScriptsApp(app: Parameters<Parameters<typeof definePluginApp>[0]>[0]) {
  app.contentScripts.register({
    id: "native-menu-styles",
    mount() {
      document.body.setAttribute("data-workspace-scripts-ui", "");
      return () => document.body.removeAttribute("data-workspace-scripts-ui");
    },
  });
  app.slots.experimental_threadAction(scriptsAction);
}
