// The Dispatch console: header, calls list, transcript, and usage (SPEC §13).
// Owned by P4. app/index.tsx renders ConsolePanel as the nav panel body, and
// passes ConsoleSidebarAccessory as the panel's sidebar accessory.
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { NAV_PANEL } from "../ids.js";
import { Icon } from "../components/ui/icon";
import { usePreferences } from "../settings/data.js";
import { useCalls, CallsList } from "./calls-list.js";
import { PodcastPanel } from "./podcast.js";
import { ConsoleHeader } from "./header.js";
import { useConsoleCallState, useConsoleBadge } from "./presence.js";
import { Transcript } from "./transcript.js";
import { UsageSummary } from "./usage.js";

export { registerStartCall } from "./actions.js";
export { useConsoleBadge } from "./presence.js";

/** Quiet status beside the native Dispatch button. No duplicate bordered pill. */
export function ConsoleSidebarAccessory() {
  const badge = useConsoleBadge();
  if (!badge) return null;
  const pending = badge.phase === "dialing" || badge.phase === "ringing" || badge.phase === "connecting";
  return (
    <span aria-label={badge.label} className="inline-flex items-center gap-1 whitespace-nowrap text-2xs tabular-nums text-muted-foreground">
      {pending ? <Icon name="Loading" className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <span className="size-1 rounded-full bg-current" aria-hidden="true" />}
      {badge.phase === "muted" ? <span>Muted</span> : null}
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
  const call = useConsoleCallState();
  const { prefs } = usePreferences();
  // The route owns the open transcript, so browser back and forward move between
  // the list and a transcript. The local copy makes the first click show at once.
  const [openId, setOpenId] = useState<string | null>(() => idFromPath(subPath ?? ""));
  useEffect(() => setOpenId(idFromPath(subPath ?? "")), [subPath]);

  // A new load for each change of live state picks up the call that just began or ended.
  const calls = useCalls(call.phase);
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
    <div className="h-full min-h-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-4 md:px-5" aria-label="Dispatch console">
        <ConsoleHeader call={call} onViewTranscript={() => liveCall && open(liveCall.id)} />
        <PodcastPanel />
        {openId ? (
          <Transcript key={openId} callId={openId} call={calls.calls?.find((row) => row.id === openId) ?? null} agentName={prefs?.agentName ?? "Agent"} onClose={close} />
        ) : (
          <>
            <UsageSummary reloadKey={call.phase} />
            <CallsList {...calls} live={call} onOpen={(row) => open(row.id)} />
          </>
        )}
      </main>
    </div>
  );
}
