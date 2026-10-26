import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_copyToClipboard,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type BbNavigate,
  type PluginThreadActionChoice,
  type PluginThreadActionDataInput,
  type PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, ShareMode, ShareStatus, TunnelMode } from "./contract";

export const REVOKE_SHARE = "session-share:revoke";
export interface RevokeRequest {
  shareId: string;
  threadId: string;
  title: string;
  returnFocusTo: HTMLElement | null;
}

const DURATION_OPTIONS = [
  [60, "1 hour"], [180, "3 hours"], [360, "6 hours"],
  [480, "8 hours"], [10080, "7 days"], [0, "Until revoked"],
] as const;
const REFRESH_MS = 30_000;
const PREPARING_REFRESH_MS = 15_000;

export function useShareSignals(onChange: () => void, threadId?: string) {
  const latest = useRef(onChange);
  latest.current = onChange;
  useRealtime("session-share", (payload) => {
    if (threadId !== undefined && (!payload || typeof payload !== "object"
      || !("threadId" in payload) || payload.threadId !== threadId)) return;
    latest.current();
  });
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (connection === "connected" && previous === "reconnecting") latest.current();
  }, [connection]);
}

interface Configuration {
  customHostname: string;
  customConfigured: boolean;
  cloudflaredAvailable: boolean;
}
interface Draft {
  mode: ShareMode;
  tunnelMode: TunnelMode;
  durationMinutes: number;
}
interface SharingData {
  configuration: Configuration | null;
  shares: ShareStatus[];
  drafts: Record<string, Draft>;
  busy: ReadonlySet<string>;
  error: string;
  execute(threadId: string, value: string, navigate: BbNavigate): Promise<void>;
}

function draftFor(data: Pick<SharingData, "configuration" | "drafts">, threadId: string): Draft {
  return data.drafts[threadId] ?? {
    mode: "view", tunnelMode: data.configuration?.customConfigured ? "custom" : "quick", durationMinutes: 180,
  };
}

function useSharing({ threadIds }: PluginThreadActionDataInput): SharingData {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<{ configuration: Configuration | null; shares: ShareStatus[] }>({ configuration: null, shares: [] });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const pending = useRef(new Set<string>());
  const visible = useRef(threadIds);
  const mounted = useRef(true);
  const sequence = useRef(0);
  visible.current = threadIds;
  const threadIdsKey = JSON.stringify(threadIds);

  const refresh = useCallback(async () => {
    const threadId = visible.current[0];
    if (!threadId) return;
    const request = ++sequence.current;
    try {
      // Configuration is shared; list loads all owner shares without per-row probes.
      const [configuration, result] = await Promise.all([
        rpc.call("status", { threadId }), rpc.call("list", null),
      ]);
      if (mounted.current && sequence.current === request) {
        setSnapshot({ configuration, shares: result.shares });
        setError("");
      }
    } catch (failure) {
      if (mounted.current && sequence.current === request) {
        setError(failure instanceof Error ? failure.message : "Could not load sharing settings.");
      }
    }
  }, [rpc]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; };
  }, []);
  useEffect(() => { if (visible.current.length) void refresh(); }, [threadIdsKey, refresh]);
  const preparing = snapshot.shares.some(share => threadIds.includes(share.threadId) && !share.ready);
  useEffect(() => {
    if (!visible.current.length) return;
    const timer = window.setInterval(() => void refresh(), preparing ? PREPARING_REFRESH_MS : REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [threadIdsKey, preparing, refresh]);
  useShareSignals(() => void refresh());

  async function execute(threadId: string, value: string, navigate: BbNavigate) {
    if (!mounted.current || pending.current.has(threadId)) return;
    if (value === "refresh") { await refresh(); return; }
    const draft = draftFor({ configuration: snapshot.configuration, drafts }, threadId);
    const share = snapshot.shares.find(item => item.threadId === threadId);
    const select = (change: Partial<Draft>) => setDrafts(previous => ({
      ...previous, [threadId]: { ...draftFor({ configuration: snapshot.configuration, drafts: previous }, threadId), ...change },
    }));
    if (value === "mode:view") { select({ mode: "view" }); return; }
    if (value === "tunnel:custom" || value === "tunnel:quick") {
      select({ tunnelMode: value === "tunnel:custom" ? "custom" : "quick" }); return;
    }
    const duration = DURATION_OPTIONS.find(([minutes]) => value === `duration:${minutes}`);
    if (duration) { select({ durationMinutes: duration[0] }); return; }
    if (value === "revoke" && share) {
      const active = document.activeElement;
      const triggerId = active?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
      const returnFocusTo = (triggerId ? document.getElementById(triggerId) : null)
        ?? (active instanceof HTMLElement ? active : null);
      const detail: RevokeRequest = { shareId: share.id, threadId, title: share.title, returnFocusTo };
      setTimeout(() => window.dispatchEvent(new CustomEvent(REVOKE_SHARE, { detail })), 0);
      return;
    }
    pending.current.add(threadId);
    setBusy(new Set(pending.current));
    try {
      if (value === "mode:review") {
        const target = await rpc.call("reviewTarget", { threadId });
        if (!target.url) throw new Error("Open a site in this thread's Pinpoint panel first.");
        if (mounted.current) select({ mode: "review" });
      } else if (value === "start") {
        const result = await rpc.call("start", { threadId, ...draft });
        sequence.current++;
        if (mounted.current) setSnapshot(current => ({
          ...current, shares: [...current.shares.filter(item => item.threadId !== threadId), result.share],
        }));
        toast.success(result.share.ready ? "Public viewer is ready." : "Publishing DNS…");
        if (mounted.current) await refresh();
      } else if (share && value === "open") {
        if (!navigate.openUrl(share.publicUrl)) throw new Error("Could not open the viewer.");
      } else if (share && (value === "copy-link" || value === "copy-code")) {
        const copied = await experimental_copyToClipboard({ text: value === "copy-link" ? share.publicUrl : share.accessCode });
        if (!copied) throw new Error("Could not copy. Try again.");
        toast.success(value === "copy-link" ? "Link copied." : "Access code copied.");
      }
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current.delete(threadId);
      if (mounted.current) setBusy(new Set(pending.current));
    }
  }
  return { ...snapshot, drafts, busy, error, execute };
}

export const sessionShareAction: PluginThreadActionRegistration<SharingData> = {
  id: "session-share", title: "Session Share", icon: "session-share/share", group: "machine",
  useData: useSharing,
  item: ({ thread, data, navigate }) => {
    const share = data.shares.find(item => item.threadId === thread.id);
    const choices: PluginThreadActionChoice[] = [];
    let hint = data.error;
    if (share) {
      choices.push(
        { id: "state", label: `${share.ready ? "Live" : "Preparing"} · ${share.mode === "review" ? "Review" : "View"}`, disabled: true },
        { id: "open", label: "Open viewer", icon: "ExternalLink", disabled: !share.ready },
        { id: "copy-link", label: "Copy link", icon: "Copy" },
        { id: "copy-code", label: "Copy access code", icon: "Copy" },
        { id: "revoke", label: "Revoke…", icon: "CircleX" },
      );
      hint ||= share.expiresAt === null ? "Until revoked." : `Expires ${new Date(share.expiresAt).toLocaleString()}.`;
    } else if (!data.configuration) {
      choices.push({ id: "loading", label: data.error ? "Sharing settings unavailable" : "Loading sharing settings…", disabled: true });
    } else {
      const draft = draftFor(data, thread.id);
      const unavailable = !data.configuration.cloudflaredAvailable
        || (draft.tunnelMode === "custom" && !data.configuration.customConfigured);
      choices.push(
        { id: "start", label: "Start sharing", icon: "Play", disabled: unavailable },
        { id: "mode:view", label: "Access: View", selected: draft.mode === "view" },
        { id: "mode:review", label: "Access: Review", selected: draft.mode === "review" },
        { id: "tunnel:custom", label: "Tunnel: Custom", selected: draft.tunnelMode === "custom" },
        { id: "tunnel:quick", label: "Tunnel: Quick", selected: draft.tunnelMode === "quick" },
        ...DURATION_OPTIONS.map(([minutes, label]) => ({ id: `duration:${minutes}`, label: `Duration: ${label}`, selected: draft.durationMinutes === minutes })),
      );
      hint ||= !data.configuration.cloudflaredAvailable ? "Install cloudflared on the BB server."
        : unavailable ? "Set the hostname and tunnel token in Session Share Configuration."
          : "Choose options, then Start sharing.";
    }
    choices.push({ id: "refresh", label: "Refresh status", icon: "RefreshCw" });
    return {
      label: "Session Share", icon: "session-share/share", disabled: data.busy.has(thread.id),
      choices: { heading: "Session Share", hint, items: choices },
      run: async ({ value }) => {
        if (value && choices.some(choice => choice.id === value && !choice.disabled)) await data.execute(thread.id, value, navigate);
      },
    };
  },
};
