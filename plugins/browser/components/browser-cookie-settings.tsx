import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, experimental_saveFile } from "@get-bb/plugin-sdk/app";
import type { browserCookieRpcContract } from "../src/browser-cookie-connection.js";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function BrowserCookieSettings() {
  const rpc = useRpc<typeof browserCookieRpcContract>();
  const [status, setStatus] = useState<{ paired: boolean; relayConnected: boolean; lastSyncAt: number | null; cookies: number; skippedPartitioned: number; localImported: boolean | null } | null>(null);
  const [pairing, setPairing] = useState<{ code: string; serverUrl: string; extensionZip: string; expiresAt: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => { void rpc.call("browserCookieStatus").then(setStatus).catch(() => setError("Could not read browser connection.")); }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("browser-cookies", refresh);
  const realtimeState = useRealtimeConnectionState();
  const previousState = useRef(realtimeState);
  useEffect(() => {
    if (realtimeState === "connected" && previousState.current !== "connected") refresh();
    previousState.current = realtimeState;
  }, [realtimeState, refresh]);
  return <div className="min-w-0 space-y-4 break-words">
    <p className="text-sm text-muted-foreground">Pair one regular browser profile as the login source. Agent and sandbox profiles do not pair here.</p>
    <p className="text-sm" role="status">{status ? status.paired ? `Regular profile: ${status.relayConnected ? "connected" : "paired, but relay offline"}.` : "No regular profile paired." : "Reading browser connection."}</p>
    {status?.paired && <p className="text-sm text-muted-foreground">{status.lastSyncAt ? `Last cookie export: ${status.cookies} cookies on ${new Date(status.lastSyncAt).toLocaleString()}. This does not show whether export is still on.` : "No cookie export received. Enable Allow cookie export in the regular profile’s extension settings if you want login seeds."}</p>}
    {status?.skippedPartitioned ? <p className="text-sm text-muted-foreground">{status.skippedPartitioned} partitioned cookies skipped.</p> : null}
    <p className="text-sm text-muted-foreground">Relay uses the regular profile directly. Cookie export is optional and only seeds new isolated sessions when Share personal logins is on. Later logins and logouts stay in that agent session; there is no continuous or two-way sync. This screen tracks one regular profile, not each sandbox browser or machine.</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { setPairing(await rpc.call("beginBrowserCookiePairing")); }
        catch { setError("Could not create a pairing code."); } finally { setBusy(false); }
      }}>{status?.paired ? "Replace regular profile" : "Pair regular profile"}</Button>
      {status?.paired && <Button variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { await rpc.call("disconnectBrowserCookies"); setPairing(null); refresh(); }
        catch { setError("Could not disconnect browser."); } finally { setBusy(false); }
      }}>Disconnect</Button>}
    </div>
    {status?.paired && <p className="text-xs text-muted-foreground">Disconnecting does not sign out existing sessions.</p>}
    {pairing && <div className="min-w-0 space-y-3 rounded-md border border-border bg-surface-recessed/70 p-3 text-sm">
      <p><a href={`data:application/zip;base64,${pairing.extensionZip}`} className="underline" download="bb-browser-cookie-sync.zip" onClick={(event) => {
        event.preventDefault();
        const bytes = Uint8Array.from(atob(pairing.extensionZip), (char) => char.charCodeAt(0));
        void experimental_saveFile({ fileName: "bb-browser-cookie-sync.zip", blob: new Blob([bytes], { type: "application/zip" }) });
      }}>Download BB Browser Cookie Sync</a>.</p>
      <label className="block space-y-1">BB address<Input aria-label="BB address" value={pairing.serverUrl} readOnly /></label>
      <label className="block space-y-1">Pairing code<Input aria-label="Pairing code" value={pairing.code} readOnly autoComplete="off" spellCheck={false} /></label>
      <p className="text-xs text-muted-foreground">Code expires in ten minutes. Enter it only in your regular profile’s extension. Completing pairing revokes the previous profile; generating a code does not.</p>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
