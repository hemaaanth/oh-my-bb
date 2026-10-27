import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, experimental_saveFile } from "@get-bb/plugin-sdk/app";
import type { browserCookieRpcContract } from "../src/browser-cookie-connection.js";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function BrowserCookieSettings() {
  const rpc = useRpc<typeof browserCookieRpcContract>();
  const [status, setStatus] = useState<{ paired: boolean; lastSyncAt: number | null; cookies: number; skippedPartitioned: number; localImported: boolean | null } | null>(null);
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
    <p className="text-sm text-muted-foreground">Uses your paired profile’s shared logins.</p>
    <p className="text-sm" role="status">{status ? status.paired ? status.lastSyncAt ? `${status.cookies} cookies synced ${new Date(status.lastSyncAt).toLocaleString()}` : "Paired. No cookie sync yet." : "No browser connected." : "Reading browser connection."}</p>
    {status?.skippedPartitioned ? <p className="text-sm text-muted-foreground">{status.skippedPartitioned} partitioned cookies skipped.</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { setPairing(await rpc.call("beginBrowserCookiePairing")); }
        catch { setError("Could not create a pairing code."); } finally { setBusy(false); }
      }}>{status?.paired ? "Pair another browser" : "Pair browser"}</Button>
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
      <p className="text-xs text-muted-foreground">Code expires in ten minutes. Pairing replaces the current connection.</p>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
