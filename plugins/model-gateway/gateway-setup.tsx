import { useEffect, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";
import type { accountPoolRpcContract } from "./src/rpc.js";

export const GATEWAY_ICON = "model-gateway/gateway";
export const SETUP_PATH = "setup";

const HARNESS_NAMES: Record<string, string> = {
  "acp-omp": "omp", "acp-fx": "FX", "acp-nanocodex": "nanocodex",
  "acp-prime-agent": "Prime Agent", pi: "Pi",
};

export function GatewaySetup() {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const [setup, setSetup] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpc.call("routing.get", null).then((routing) => {
      if (!cancelled) setSetup(routing.setup);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [rpc]);
  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto w-full max-w-[760px] space-y-4 px-4 py-6">
        <Button variant="ghost" size="sm" className="h-5 px-0" asChild><UrlLink href="/settings/plugins/model-gateway"><Icon name="ChevronLeft" />Settings</UrlLink></Button>
        <header className="flex items-center gap-3">
          <Icon name={GATEWAY_ICON} aria-hidden className="size-9 shrink-0" />
          <div className="min-w-0"><h1 className="text-lg font-semibold">Set up Model Gateway</h1>
            <p className="text-xs text-subtle-foreground">Connect accounts, then choose routes for each harness.</p></div>
        </header>
        <section className="space-y-2 border-t border-border pt-5">
          <h2 className="text-sm font-medium">1. Add an upstream</h2>
          <p className="text-sm text-muted-foreground">Open Credentials in settings. Sign in to Claude or ChatGPT, import a login from the BB server, or add an API key. Saved secrets stay hidden.</p>
          <p className="text-sm text-muted-foreground">API keys bill per token. Upstream billing limits and key restrictions control spending.</p>
        </section>
        <section className="space-y-2 border-t border-border pt-5">
          <h2 className="text-sm font-medium">2. Choose routes</h2>
          <p className="text-sm text-muted-foreground">Edit a route in settings. Upstreams run in order. Turning a route off uses that harness's own login. Claude subscription OAuth is limited to Claude Code unless you opt in under Preferences.</p>
        </section>
        <section className="space-y-3 border-t border-border pt-5">
          <h2 className="text-sm font-medium">3. Set up each machine</h2>
          <p className="text-sm text-muted-foreground">Claude Code and Codex need no setup files. Other harnesses use the commands below. Gateway displays these instructions but never runs them.</p>
          <p className="text-sm text-muted-foreground">FX, nanocodex, and Prime Agent use optional adapters. Gateway does not install or enable them.</p>
          {error ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : setup === null ? <p className="text-sm text-muted-foreground">Loading setup instructions…</p> : Object.entries(setup).map(([target, command]) => (
            <div key={target} className="min-w-0 space-y-2 pt-2">
              <h3 className="text-sm font-medium">{HARNESS_NAMES[target] ?? target}</h3>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface-recessed px-3 py-2 font-mono text-xs"><code>{command}</code></pre>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
