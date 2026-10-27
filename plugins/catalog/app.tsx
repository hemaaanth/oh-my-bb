import { useCallback, useEffect, useState } from "react";
import { definePluginApp, experimental_useQuestionFormHost, useRealtime, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { z } from "zod";
import type { executorApprovalsSchema, rpcContract } from "./contract";
import { CatalogPanel } from "./catalog-panel";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";

/** Must match APPROVAL_RENDERER_ID and APPROVALS_CHANGED in server.ts. */
const APPROVAL_RENDERER_ID = "executor-approval";
const APPROVALS_CHANGED = "executor-approvals-changed";
type ApprovalPayload = {
  approvalId: string; toolkit: string; address: string; integration: string; account: string | null; tool: string;
  description: string | null; reason: string; message: string; args: string; approvalUrl: string;
};
type PendingApprovals = z.infer<typeof executorApprovalsSchema>["pending"];

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
  const rpc = useRpc<typeof rpcContract>();
  const { shortcuts, registerChoiceHandler } = experimental_useQuestionFormHost();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingApprovals>([]);
  const payload = isApprovalPayload(interaction.payload) ? interaction.payload : null;
  const load = useCallback(async () => {
    setPending((await rpc.call("executorApprovals", { threadId: interaction.threadId })).pending);
  }, [rpc, interaction.threadId]);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  useRealtime(APPROVALS_CHANGED, useCallback((event: unknown) => {
    if ((event as { threadId?: unknown } | null)?.threadId === interaction.threadId) void load().catch(() => undefined);
  }, [load, interaction.threadId]));
  const others = pending.filter((entry) => entry.approvalId !== payload?.approvalId);
  const answer = useCallback(async (approved: boolean, scope: "once" | "thread" | "all" = "once") => {
    setBusy(true);
    try { await submit({ approved, scope }); } finally { setBusy(false); }
  }, [submit]);
  useEffect(() => registerChoiceHandler((index) => {
    if (busy) return false;
    if (index === CHOICES.approve) void answer(true);
    else if (index === CHOICES.thread) void answer(true, "thread");
    else if (index === CHOICES.decline) void answer(false);
    else if (index === CHOICES.all && others.length) void answer(true, "all");
    else return false;
    return true;
  }), [registerChoiceHandler, answer, busy, others.length]);
  if (!payload) return <p role="alert" className="text-sm text-destructive">This approval request is malformed.</p>;
  const rows = payload.args ? argumentRows(payload.args) : null;
  const key = (choice: number) => {
    const shortcut = shortcuts.get(String(choice));
    return shortcut ? <kbd className="ml-1.5 font-mono text-[10px] opacity-60">{shortcut.label}</kbd> : null;
  };
  const keys = (choice: number) => shortcuts.get(String(choice))?.ariaKeyshortcuts;
  const position = pending.findIndex((entry) => entry.approvalId === payload.approvalId);
  return (
    <div className="w-full space-y-3 text-[13px]">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate font-medium">{payload.integration}{payload.account ? <span className="font-normal text-muted-foreground"> · {payload.account}</span> : null}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            {pending.length > 1 && position >= 0 ? <span className="text-xs text-muted-foreground">{position + 1} of {pending.length}</span> : null}
            <Pill variant="secondary" className="rounded-full px-2 py-0.5 text-[10px] font-medium">{payload.toolkit}</Pill>
          </div>
        </div>
        <p className="line-clamp-3">{payload.description ?? `Run ${payload.tool}.`}</p>
        <p className="break-all font-mono text-[11px] text-muted-foreground">{payload.address.replace(/^tools\./u, "")}</p>
      </div>
      <p className="text-xs text-muted-foreground">{payload.reason}</p>
      {payload.message ? <p className="text-xs text-muted-foreground">{payload.message}</p> : null}
      {rows ? (
        rows.length ? (
          <dl className="grid max-h-56 grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 overflow-auto rounded-md bg-muted px-2.5 py-2 text-xs">
            {rows.map(([name, value]) => [
              <dt key={`k:${name}`} className="font-mono text-muted-foreground">{name}</dt>,
              <dd key={`v:${name}`} className="whitespace-pre-wrap break-words">{value}</dd>,
            ])}
          </dl>
        ) : null
      ) : payload.args ? <pre className="max-h-56 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[11px] leading-4">{payload.args}</pre> : null}
      {others.length ? (
        <div className="text-xs text-muted-foreground">
          <p>{others.length} more call{others.length === 1 ? " is" : "s are"} waiting in this thread:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{others.slice(0, 4).map((entry) => <li key={entry.approvalId} className="truncate">{entry.summary}</li>)}{others.length > 4 ? <li>…</li> : null}</ul>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
        <a className="mr-auto text-muted-foreground underline-offset-2 hover:underline" href={payload.approvalUrl} target="_blank" rel="noreferrer">Open in Executor</a>
        <Button size="sm" variant="outline" disabled={busy} aria-keyshortcuts={keys(CHOICES.decline)} onClick={() => void answer(false)}>Decline{key(CHOICES.decline)}</Button>
        <Button size="sm" variant="outline" disabled={busy} aria-keyshortcuts={keys(CHOICES.thread)} onClick={() => void answer(true, "thread")}>Approve for this thread{key(CHOICES.thread)}</Button>
        {others.length ? <Button size="sm" variant="outline" disabled={busy} aria-keyshortcuts={keys(CHOICES.all)} onClick={() => void answer(true, "all")}>Approve all {others.length + 1}{key(CHOICES.all)}</Button> : null}
        <Button size="sm" disabled={busy} aria-keyshortcuts={keys(CHOICES.approve)} onClick={() => void answer(true)}>Approve{key(CHOICES.approve)}</Button>
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
  app.slots.pendingInteraction({ id: APPROVAL_RENDERER_ID, component: ExecutorApproval });
  app.slots.experimental_appOverlay({ id: "connection-alerts", component: ConnectionAlerts });
});
