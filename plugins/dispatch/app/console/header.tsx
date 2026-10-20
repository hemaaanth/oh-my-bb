// Agent identity, inline call status, and the actions for the current phase.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import type { RpcContract } from "../../shared/contract.js";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { dialPhone } from "../phone-dial.js";
import { privateCallText } from "../phone-status.js";
import { errorText, useLatest, usePreferences } from "../settings/data.js";
import { Note } from "../settings/layout.js";
import { useStartCall } from "./actions.js";
import { formatElapsed } from "./format.js";
import { callStatusText, type CallState } from "./presence.js";

export function ConsoleHeader({ call, onViewTranscript }: { call: CallState; onViewTranscript: () => void }) {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const { prefs } = usePreferences();
  const startCall = useStartCall();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const name = prefs?.agentName ?? "your agent";
  const connecting = call.phase === "connecting";
  const dialing = call.phase === "dialing" || call.phase === "ringing";

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (cause) {
      setMessage(privateCallText(errorText(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised text-muted-foreground" aria-hidden="true">
            <Icon name="dispatch/dispatch" className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-foreground">{name}</h1>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              {connecting || dialing ? <Icon name="Loading" className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : call.live ? <span className="size-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
              <span>{callStatusText(call)}</span>
              {call.live && call.startedAt !== null ? <span className="tabular-nums text-foreground" aria-label="Elapsed call time">{formatElapsed((call.now - call.startedAt) / 1000)}</span> : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Call actions">
          {call.live ? <>
            {call.channel !== "phone" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => rpcRef.current.call("relayCommand", { command: call.muted ? "unmute" : "mute", ...(call.nonce ? { nonce: call.nonce } : {}) }))}>
              <Icon name="Mic" />{call.muted ? "Unmute" : "Mute"}
            </Button> : null}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => rpcRef.current.call("endCallsEverywhere", { ...(call.nonce ? { nonce: call.nonce } : {}), reason: "console" }))}>
              <Icon name="Square" />Stop
            </Button>
            <Button variant="ghost" size="sm" onClick={onViewTranscript}>View transcript</Button>
          </> : <>
            <Button size="sm" disabled={busy || !startCall || dialing || connecting} onClick={() => void run(async () => startCall?.())}>
              <Icon name="Mic" />{connecting ? "Connecting…" : `Wake ${name}`}
            </Button>
            <Button variant="outline" size="sm" disabled={busy || dialing || connecting} onClick={() => void run(() => dialPhone(rpcRef.current, { agentName: name }))}>
              <Icon name="Smartphone" />{dialing ? "Calling…" : "Call my phone"}
            </Button>
          </>}
        </div>
      </div>
      {message ? <Note tone="error">{message}</Note> : null}
    </header>
  );
}
