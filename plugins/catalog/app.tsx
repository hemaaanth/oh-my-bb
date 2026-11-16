import { useCallback, useEffect, useState } from "react";
import { definePluginApp, experimental_useQuestionFormHost, useRealtime, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./contract";
import { CatalogPanel, CatalogIntegrationSettings } from "./catalog-panel";
import { Button } from "@/components/ui/button";

/** Must match APPROVAL_RENDERER_ID and APPROVALS_CHANGED in server.ts. */
const APPROVAL_RENDERER_ID = "executor-approval";
type ApprovalPayload = {
  approvalId: string; toolkit: string; address: string; integration: string; account: string | null; tool: string;
  purpose?: string; script?: boolean; description: string | null; reason: string; message: string; args: string; approvalUrl: string;
};

const isApprovalPayload = (value: unknown): value is ApprovalPayload =>
  Boolean(value && typeof value === "object" && !Array.isArray(value)
    && ["approvalId", "toolkit", "address", "integration", "tool", "reason", "message", "args", "approvalUrl"].every((key) => typeof (value as Record<string, unknown>)[key] === "string"));

/** Flat objects read better as a list; anything else, or truncated JSON, stays as text. */
function argumentRows(args: string): Array<[string, string]> | null {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.entries(parsed).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
  } catch {
    return null;
  }
}

/** Choice indexes bb's shortcuts map to. */
const CHOICES = { approve: 0, thread: 1, decline: 2, all: 3 } as const;

/** An Executor call waiting for approval, answered in the thread instead of on Executor's page. */
function ExecutorApproval({ interaction, submit }: PluginPendingInteractionProps) {
  const { shortcuts, registerChoiceHandler } = experimental_useQuestionFormHost();
  const [busy, setBusy] = useState(false);
  const payload = isApprovalPayload(interaction.payload) ? interaction.payload : null;
  const answer = useCallback(async (approved: boolean, scope: "once" | "thread" | "all" = "once") => {
    setBusy(true);
    try { await submit({ approved, scope }); } finally { setBusy(false); }
  }, [submit]);
  useEffect(() => registerChoiceHandler((index) => {
    if (busy) return false;
    if (index === CHOICES.approve) void answer(true);
    else if (index === CHOICES.thread && !payload?.script) void answer(true, "thread");
    else if (index === CHOICES.decline) void answer(false);
    else return false;
    return true;
  }), [registerChoiceHandler, answer, busy, payload?.script]);
  if (!payload) return <p role="alert" className="text-sm text-destructive">This approval request is malformed.</p>;
  const rows = payload.args ? argumentRows(payload.args) : null;
  const key = (choice: number) => {
    const shortcut = shortcuts.get(String(choice));
    return shortcut ? <kbd className="ml-1.5 font-mono text-[10px] opacity-60">{shortcut.label}</kbd> : null;
  };
  const keys = (choice: number) => shortcuts.get(String(choice))?.ariaKeyshortcuts;
  const code = rows?.find(([name]) => name === "code")?.[1];
  return (
    <div className="w-full space-y-3 text-[13px]">
      {!payload.script && rows?.length ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.filter(([name]) => name !== "intent").slice(0, 6).map(([name, value]) => <div key={name} className="contents"><dt className="text-muted-foreground">{name}</dt><dd className="whitespace-pre-wrap break-words">{value.length > 300 ? `${value.slice(0, 300)}…` : value}</dd></div>)}
      </dl> : null}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">{payload.script ? "View code" : "Details"}</summary>
        {!payload.script || !code ? <p className="my-2 break-all font-mono text-[11px]">{payload.address}</p> : null}
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-2 font-mono text-[11px] leading-4">{code ?? payload.args}</pre>
      </details>
      <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
        <span className="mr-auto" />
        <Button size="sm" variant="outline" disabled={busy} aria-keyshortcuts={keys(CHOICES.decline)} onClick={() => void answer(false)}>Decline{key(CHOICES.decline)}</Button>
        {!payload.script ? <Button size="sm" variant="outline" disabled={busy} aria-keyshortcuts={keys(CHOICES.thread)} onClick={() => void answer(true, "thread")}>Allow this tool for this thread{key(CHOICES.thread)}</Button> : null}
        <Button size="sm" disabled={busy} aria-keyshortcuts={keys(CHOICES.approve)} onClick={() => void answer(true)}>Allow once{key(CHOICES.approve)}</Button>
      </div>
    </div>
  );
}

/** Must match CONNECTIONS_CHANGED in server.ts. */
const CONNECTIONS_CHANGED = "executor-connections-changed";
/** Keep an unchanged, dismissed alert quiet across overlay remounts. */
let shownBreak = "";

/** One compact alert; connection diagnostics stay in Executor. */
function ConnectionAlerts() {
  const rpc = useRpc<typeof rpcContract>();
  const show = useCallback(async () => {
    const { url, broken } = await rpc.call("executorConnections", null);
    const id = "executor-connections-attention";
    // Remove alerts left by the previous per-connection overlay after a reload.
    for (const connection of broken) toast.dismiss(`executor-connection-${connection.address}`);
    if (!broken.length) { shownBreak = ""; toast.dismiss(id); return; }
    const key = broken.map(connection => `${connection.address} ${connection.since} ${connection.problem.split(":", 1)[0]}`).sort().join("|");
    if (shownBreak === key) return;
    shownBreak = key;
    const name = broken[0].name.replace(/^tools\./u, "").split(/[.(]/u)[0].trim().slice(0, 40) || "Connection";
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    toast.warning(broken.length === 1 ? `${label} needs attention` : `${broken.length} connections need attention`, {
      id,
      description: broken.length === 1 && /^expired(?::|$)/u.test(broken[0].problem) ? "Sign-in expired." : undefined,
      duration: Infinity,
      action: url ? { label: "Open Executor", onClick: () => { window.open(url, "_blank", "noopener"); } } : undefined,
    });
  }, [rpc]);
  useEffect(() => { void show().catch(() => undefined); }, [show]);
  useRealtime(CONNECTIONS_CHANGED, useCallback((event: unknown) => {
    const recovered = (event as { recovered?: { address: string }[] } | null)?.recovered ?? [];
    for (const connection of recovered) toast.dismiss(`executor-connection-${connection.address}`);
    void show().catch(() => undefined);
  }, [show]));
  return null;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "catalog", component: CatalogPanel });
  app.slots.settingsSection({ id: "oh-my-bb", component: CatalogIntegrationSettings });
  app.slots.pendingInteraction({ id: APPROVAL_RENDERER_ID, component: ExecutorApproval });
  app.slots.experimental_appOverlay({ id: "connection-alerts", component: ConnectionAlerts });
});
