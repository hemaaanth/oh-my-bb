// The Dispatch console: header, calls list, transcript, and usage (SPEC §13).
// Owned by P4. app/index.tsx renders ConsolePanel as the nav panel body, and
// passes ConsoleSidebarAccessory as the panel's sidebar accessory.
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { NAV_PANEL } from "../ids.js";
import { usePreferences } from "../settings/data.js";
import { useCalls, CallsList } from "./calls-list.js";
import { ConsoleHeader } from "./header.js";
import { useCallState, useConsoleBadge } from "./presence.js";
import { Transcript } from "./transcript.js";
import { UsageSummary } from "./usage.js";

export { registerStartCall } from "./actions.js";
export { useConsoleBadge } from "./presence.js";

/** The "Live" or "Muted" pill beside the Dispatch sidebar entry. Empty when idle. */
export function ConsoleSidebarAccessory() {
  const badge = useConsoleBadge();
  if (!badge) return null;
  const tone = badge.tone === "warning" ? "text-warning" : "text-muted-foreground";
  return (
    <span aria-label={badge.label} className={`inline-flex h-4 items-center rounded-full border border-border-hairline px-1 text-[10px] ${tone}`}>
      {badge.text}
    </span>
  );
}

const idFromPath = (subPath: string): string | null => {
  const first = subPath.split("/")[0] ?? "";
  if (!first) return null;
  try {
    return decodeURIComponent(first);
  } catch {
    return first;
  }
};

export function ConsolePanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const call = useCallState();
  const { prefs } = usePreferences();
  // The route owns the open transcript, so browser back and forward move between
  // the list and a transcript. The local copy makes the first click show at once.
  const [openId, setOpenId] = useState<string | null>(() => idFromPath(subPath ?? ""));
  useEffect(() => setOpenId(idFromPath(subPath ?? "")), [subPath]);

  // A new load for each change of live state picks up the call that just began or ended.
  const calls = useCalls(call.live);
  const liveCall = calls.calls?.find((row) => row.endedAt === null && !row.unclean) ?? null;

  const open = (id: string) => {
    setOpenId(id);
    navigate.toPluginPanel(NAV_PANEL.path, { subPath: encodeURIComponent(id) });
  };
  const close = () => {
    setOpenId(null);
    navigate.toPluginPanel(NAV_PANEL.path);
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-4">
      <ConsoleHeader call={call} onViewTranscript={() => liveCall && open(liveCall.id)} />
      {openId ? (
        <Transcript key={openId} callId={openId} call={calls.calls?.find((row) => row.id === openId) ?? null} agentName={prefs?.agentName ?? "Agent"} onClose={close} />
      ) : (
        <>
          <CallsList {...calls} onOpen={(row) => open(row.id)} />
          <UsageSummary reloadKey={call.live} />
        </>
      )}
    </div>
  );
}
