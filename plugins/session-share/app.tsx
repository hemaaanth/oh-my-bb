import { useEffect, useRef, useState } from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import {
  definePluginApp,
  experimental_copyToClipboard,
  experimental_usePluginId,
  UrlLink,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { rpcContract, ShareStatus } from "./contract";
import { REVOKE_SHARE, sessionShareAction, useShareSignals, type RevokeRequest } from "./share-menu";

export const SETTINGS_REFRESH_MS = 60_000;

function expiryLabel(expiresAt: number | null): string {
  if (expiresAt === null) return "Until revoked";
  const remainingMinutes = Math.max(
    0,
    Math.ceil((expiresAt - Date.now()) / 60_000),
  );
  if (remainingMinutes >= 24 * 60) {
    return `${Math.ceil(remainingMinutes / (24 * 60))}d`;
  }
  return remainingMinutes >= 60
    ? `${Math.ceil(remainingMinutes / 60)}h`
    : `${remainingMinutes}m`;
}


function RevokeConfirmation({ title, onConfirm, children, open: controlledOpen, onOpenChange, onCloseAutoFocus }: {
  title: string;
  onConfirm(): Promise<void>;
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  onCloseAutoFocus?(event: Event): void;
}) {
  const pluginId = experimental_usePluginId();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scope = { "data-bb-plugin": pluginId, "data-bb-plugin-root": "", "data-bb-portaled-overlay": "" };
  return <AlertDialogPrimitive.Root open={open} onOpenChange={setOpen}>
    {children && <AlertDialogPrimitive.Trigger asChild>{children}</AlertDialogPrimitive.Trigger>}
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay {...scope} className="fixed inset-0 z-[70] bg-black/40" />
      <AlertDialogPrimitive.Content {...scope} onCloseAutoFocus={onCloseAutoFocus} className="fixed bottom-0 left-0 z-[71] w-full rounded-t-md border border-border bg-background p-4 text-foreground shadow-lg sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-md">
        <AlertDialogPrimitive.Title className="text-sm font-semibold">Revoke share?</AlertDialogPrimitive.Title>
        <AlertDialogPrimitive.Description className="mt-2 break-words text-sm text-muted-foreground">
          Guests will lose access to “{title}”. This cannot be undone.
        </AlertDialogPrimitive.Description>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <AlertDialogPrimitive.Cancel asChild><Button variant="outline" disabled={busy}>Cancel</Button></AlertDialogPrimitive.Cancel>
          <Button disabled={busy} className="text-destructive" onClick={() => {
            setBusy(true);
            setError("");
            void onConfirm().then(() => setOpen(false), (failure) => setError(failure instanceof Error ? failure.message : "Could not revoke this share.")).finally(() => setBusy(false));
          }}>Revoke</Button>
        </div>
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  </AlertDialogPrimitive.Root>;
}


function SessionShareSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const { openUrl } = useBbNavigate();
  const [shares, setShares] = useState<ShareStatus[]>([]);
  const [message, setMessage] = useState("");

  async function refresh() {
    setShares((await rpc.call("list", null)).shares);
  }

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = window.setInterval(
      () => void refresh().catch(() => undefined),
      SETTINGS_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, []);
  useShareSignals(() => void refresh().catch(() => undefined));

  async function revoke(shareId: string) {
    await rpc.call("revoke", { shareId });
    setMessage("Share revoked.");
    await refresh();
  }

  function copy(value: string, label: string) {
    void experimental_copyToClipboard({ text: value }).then((copied) =>
      setMessage(copied ? `${label} copied.` : `Could not copy ${label.toLowerCase()}.`),
    );
  }

  return (
    <div className="space-y-4">
      <details className="group overflow-hidden rounded-md border border-border bg-surface-recessed/70">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 border-border p-3 text-sm group-open:border-b [&::-webkit-details-marker]:hidden">
          <span>Shared sessions</span>
          <span className="flex shrink-0 items-center gap-2">
            {shares.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {shares.length}
              </span>
            )}
            <Icon name="ChevronDown" className="size-4 transition-transform group-open:rotate-180" />
          </span>
        </summary>

        {shares.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            No active shares.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {shares.map((share) => {
              return (
                <div className="space-y-3 p-3" key={share.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            share.ready ? "bg-success" : "bg-muted-foreground/50",
                          )}
                        />
                        <span className="truncate text-sm font-medium">
                          {share.title}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {share.mode === "review" ? "Pinpoint review" : "View only"}
                        {" · "}
                        {share.tunnelMode}
                        {!share.ready && " · restoring"}
                        {" · "}
                        {expiryLabel(share.expiresAt)}
                      </p>
                    </div>
                    <RevokeConfirmation title={share.title} onConfirm={() => revoke(share.id)}>
                      <Button className="text-destructive hover:text-destructive" size="sm" type="button" variant="ghost">
                        Revoke
                      </Button>
                    </RevokeConfirmation>
                  </div>

                  <div className="flex items-center gap-2 rounded-md bg-muted/40 p-2 pl-3">
                    <code className="min-w-0 flex-1 truncate text-xs">
                      {share.publicUrl}
                    </code>
                    <Button
                      aria-label="Copy public link"
                      className="size-7"
                      onClick={() => copy(share.publicUrl, "Link")}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Icon name="Copy" />
                    </Button>
                    <Button
                      aria-label="Open public link"
                      className="size-7"
                      disabled={!share.ready}
                      onClick={() => openUrl(share.publicUrl)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Icon name="ExternalLink" />
                    </Button>
                  </div>

                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-muted-foreground">Access code</span>
                    <button
                      className="font-mono text-foreground hover:underline"
                      onClick={() => copy(share.accessCode, "Access code")}
                      type="button"
                    >
                      {share.accessCode}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </details>
      <p aria-live="polite" className={cn("text-xs text-muted-foreground", !message && "sr-only")}>
        {message}
      </p>
    </div>
  );
}


function SessionShareRevokeOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const opener = useRef<HTMLElement | null>(null);
  const outsideFocus = useRef<HTMLElement | null>(null);
  const [request, setRequest] = useState<RevokeRequest | null>(null);

  useEffect(() => {
    const remember = (event: Event) => {
      const target = event.target instanceof Element
        ? event.target.closest("button, a[href], input, select, textarea, [tabindex]") : null;
      if (target instanceof HTMLElement && target !== document.body
        && !target.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) {
        outsideFocus.current = target;
      }
    };
    document.addEventListener("focusin", remember);
    document.addEventListener("pointerdown", remember, true);
    return () => {
      document.removeEventListener("focusin", remember);
      document.removeEventListener("pointerdown", remember, true);
    };
  }, []);
  useEffect(() => {
    const handler = (event: Event) => {
      const next = (event as CustomEvent<RevokeRequest>).detail;
      if (typeof next?.shareId !== "string" || !next.shareId) return;
      const target = next.returnFocusTo;
      opener.current = target instanceof HTMLElement && target !== document.body
        && !target.closest('[role="menu"], [role="dialog"]') ? target : outsideFocus.current;
      setRequest(next);
    };
    window.addEventListener(REVOKE_SHARE, handler);
    return () => window.removeEventListener(REVOKE_SHARE, handler);
  }, []);
  useEffect(() => { setRequest(null); }, [context.threadId]);

  if (!request) return null;
  return <RevokeConfirmation
    title={request.title}
    open
    onOpenChange={(open) => { if (!open) setRequest(null); }}
    onConfirm={async () => { await rpc.call("revoke", { shareId: request.shareId }); }}
    onCloseAutoFocus={(event) => {
      const target = opener.current?.isConnected ? opener.current : outsideFocus.current;
      if (target?.isConnected) { event.preventDefault(); target.focus(); }
    }}
  />;
}

function SetupGuide() {
  return <details className="group rounded-md border border-border bg-surface-recessed/70 p-3">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm [&::-webkit-details-marker]:hidden">
      Setup guide<Icon name="ChevronDown" className="size-4 shrink-0 transition-transform group-open:rotate-180" />
    </summary>
    <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm text-muted-foreground">
      <p>Install cloudflared on the BB server machine. Session Share never downloads or installs it. Set its path in Configuration if it is not on PATH.</p>
      <p>Quick mode creates a temporary Cloudflare hostname. Custom mode uses your existing named tunnel. Configure its token and a subdomain such as share.example.com. Route only the isolated viewer port, not BB.</p>
      <p>Open the Session Share submenu beside Scripts in a thread&apos;s ⋯ menu. Choose access, tunnel and duration, then Start sharing. Copy the link and access code from the submenu and send them privately. Revoke a stored share to end access. Stored links restore after restart; Quick hostnames may change.</p>
      <p>Review is optional and runs only when selected or when restoring an existing Review share. It requires a compatible Pinpoint installation and a site already open in that thread. <UrlLink href="/settings/plugins/pinpoint" className="underline">Pinpoint settings</UrlLink></p>
      <p>Access codes remain in the local plugin database so owners can copy them again. Guest cookies expire after four hours or at the share expiry, whichever comes first. Until revoked links have no automatic share expiry.</p>
    </div>
  </details>;
}

function MoreSettings() {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium">More</h2>
      <SessionShareSettings />
      <SetupGuide />
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "more", component: MoreSettings });
  app.slots.experimental_appOverlay({ id: "session-share", component: SessionShareRevokeOverlay });
  app.slots.experimental_threadAction(sessionShareAction);
});
