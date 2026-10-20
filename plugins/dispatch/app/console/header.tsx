// The console header (SPEC §13.1): the live call's controls, or the buttons
// that start a call.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import type { RpcContract } from "../../shared/contract.js";
import { Button } from "../components/ui/button";
import { dialPhone } from "../phone-dial.js";
import { errorText, useLatest, usePreferences } from "../settings/data.js";
import { Note } from "../settings/layout.js";
import { useStartCall } from "./actions.js";
import { formatElapsed } from "./format.js";
import type { CallState } from "./presence.js";

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function ConsoleHeader({ call, onViewTranscript }: { call: CallState; onViewTranscript: () => void }) {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const { prefs } = usePreferences();
  const startCall = useStartCall();
  const now = useNow(call.live);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const name = prefs?.agentName ?? "your agent";

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (cause) {
      setMessage(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  if (call.live) {
    return (
      <header className="flex flex-col gap-2 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-sm text-foreground">
            <span aria-hidden="true" className={call.muted ? "size-2 rounded-full bg-muted-foreground" : "size-2 animate-pulse rounded-full bg-foreground"} />
            {call.muted ? "Muted" : "Live"}
            {call.startedAt ? <span className="tabular-nums text-muted-foreground">{formatElapsed((now - call.startedAt) / 1000)}</span> : null}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => rpcRef.current.call("relayCommand", { command: call.muted ? "unmute" : "mute", ...(call.nonce ? { nonce: call.nonce } : {}) }))}>
              {call.muted ? "Unmute" : "Mute"}
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void run(() => rpcRef.current.call("endCallsEverywhere", { ...(call.nonce ? { nonce: call.nonce } : {}), reason: "console" }))}>
              Stop
            </Button>
            <Button variant="ghost" size="sm" onClick={onViewTranscript}>
              View transcript
            </Button>
          </div>
        </div>
        {message ? <Note tone="error">{message}</Note> : null}
      </header>
    );
  }

  return (
    <header className="flex flex-col gap-2 pb-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !startCall} onClick={() => void run(async () => startCall?.())}>
          Wake {name}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => dialPhone(rpcRef.current, { agentName: name }))}>
          Call my phone
        </Button>
      </div>
      {message ? <Note tone="error">{message}</Note> : null}
    </header>
  );
}
