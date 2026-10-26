import { useEffect, useRef, useState } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import {
  definePluginApp,
  experimental_copyToClipboard,
  experimental_usePluginId,
  UrlLink,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type {
  rpcContract,
  ShareMode,
  ShareStatus,
  TunnelMode,
} from "./contract";

// Share state changes arrive as `session-share` realtime signals (see
// server.ts), so surfaces refresh on those instead of polling. The timers
// below only run while their surface is mounted: a slow refresh keeps expiry
// labels and host settings current, and a faster fallback covers a share that
// is still preparing in case its ready signal raced the start response.
const SHARE_SIGNAL_CHANNEL = "session-share";
const OPEN_SHARE = "session-share:open";
export const PANEL_REFRESH_MS = 30_000;
export const SETTINGS_REFRESH_MS = 60_000;
export const PREPARING_REFRESH_MS = 15_000;

interface OpenShareRequest {
  threadId: string;
  returnFocusTo: HTMLElement | null;
}

/**
 * Calls `onChange` when the server signals a share change (optionally only for
 * one thread) and after the realtime connection recovers, since signals sent
 * while disconnected are lost.
 */
function useShareSignals(onChange: () => void, threadId?: string) {
  const latest = useRef(onChange);
  latest.current = onChange;
  useRealtime(SHARE_SIGNAL_CHANNEL, (payload) => {
    if (
      threadId !== undefined &&
      (!payload ||
        typeof payload !== "object" ||
        !("threadId" in payload) ||
        payload.threadId !== threadId)
    ) {
      return;
    }
    latest.current();
  });
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (connection === "connected" && previous === "reconnecting") {
      latest.current();
    }
  }, [connection]);
}

interface ConfigurationState {
  customHostname: string;
  cloudflaredAvailable: boolean;
  customConfigured: boolean;
}


function ChoiceButton({
  active,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <Button
      aria-pressed={active}
      className={cn(
        "h-9 min-w-0 justify-center rounded-md px-2 text-sm shadow-none",
        active
          ? "bg-background text-foreground shadow-sm hover:bg-background"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
      variant="ghost"
    >
      {label}
    </Button>
  );
}

function ShareDialogFooter({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 justify-end gap-2 border-t border-border p-3">
      <DialogPrimitive.Close asChild><Button type="button" variant="outline">Done</Button></DialogPrimitive.Close>
      {children}
    </div>
  );
}

function CopyField({
  label,
  value,
  onCopied,
  onCopyFailed,
}: {
  label: string;
  value: string;
  onCopied(): void;
  onCopyFailed(): void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1 border-b border-border pb-2">
        <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
        <Button
          aria-label={`Copy ${label.toLowerCase()}`}
          className="size-7"
          onClick={() => void experimental_copyToClipboard({ text: value }).then((copied) => copied ? onCopied() : onCopyFailed())}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Icon name="Copy" />
        </Button>
      </div>
    </div>
  );
}

const DURATION_OPTIONS = [
  ["60", "1 hour"],
  ["180", "3 hours"],
  ["360", "6 hours"],
  ["480", "8 hours"],
  ["10080", "7 days"],
  ["0", "Until revoked"],
] as const;

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

function DurationSelect({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange(value: string): void;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(next) => {
      if (DURATION_OPTIONS.some(([option]) => option === next)) onValueChange(next);
    }}>
      <SelectPrimitive.Trigger
        aria-label="Duration"
        className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon asChild>
          <Icon name="ChevronDown" className="size-4 opacity-60" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Content
        className="z-[60] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
        position="popper"
        sideOffset={4}
      >
        <SelectPrimitive.Viewport className="p-1">
          {DURATION_OPTIONS.map(([optionValue, label]) => (
            <SelectPrimitive.Item
              className="relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-state-active focus:text-foreground"
              key={optionValue}
              value={optionValue}
            >
              <SelectPrimitive.ItemIndicator className="absolute left-2 flex size-4 items-center justify-center">
                <Icon name="Check" className="size-4" />
              </SelectPrimitive.ItemIndicator>
              <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
            </SelectPrimitive.Item>
          ))}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Root>
  );
}

function RevokeConfirmation({ title, onConfirm, children }: {
  title: string;
  onConfirm(): Promise<void>;
  children: React.ReactNode;
}) {
  const pluginId = experimental_usePluginId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmation = useRef({ title, onConfirm });
  const scope = { "data-bb-plugin": pluginId, "data-bb-plugin-root": "", "data-bb-portaled-overlay": "" };
  return <AlertDialogPrimitive.Root open={open} onOpenChange={(next) => {
    if (next) confirmation.current = { title, onConfirm };
    setOpen(next);
  }}>
    <AlertDialogPrimitive.Trigger asChild>{children}</AlertDialogPrimitive.Trigger>
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay {...scope} className="fixed inset-0 z-[70] bg-black/40" />
      <AlertDialogPrimitive.Content {...scope} className="fixed bottom-0 left-0 z-[71] w-full rounded-t-md border border-border bg-background p-4 text-foreground shadow-lg sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-md">
        <AlertDialogPrimitive.Title className="text-sm font-semibold">Revoke share?</AlertDialogPrimitive.Title>
        <AlertDialogPrimitive.Description className="mt-2 break-words text-sm text-muted-foreground">
          Guests will lose access to “{confirmation.current.title}”. This cannot be undone.
        </AlertDialogPrimitive.Description>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <AlertDialogPrimitive.Cancel asChild><Button variant="outline" disabled={busy}>Cancel</Button></AlertDialogPrimitive.Cancel>
          <Button disabled={busy} className="text-destructive" onClick={() => {
            setBusy(true);
            setError("");
            void confirmation.current.onConfirm().then(() => setOpen(false), (failure) => setError(failure instanceof Error ? failure.message : "Could not revoke this share.")).finally(() => setBusy(false));
          }}>Revoke</Button>
        </div>
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  </AlertDialogPrimitive.Root>;
}

function SessionSharePanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { openUrl } = useBbNavigate();
  const [share, setShare] = useState<ShareStatus | null>(null);
  const [configuration, setConfiguration] =
    useState<ConfigurationState | null>(null);
  const [mode, setMode] = useState<ShareMode | null>(null);
  const [targetUrl, setTargetUrl] = useState<string | null>(null);
  const [checkingTarget, setCheckingTarget] = useState(true);
  const checkedTarget = useRef(false);
  const requestVersion = useRef(0);
  const operation = useRef(false);
  const [durationMinutes, setDurationMinutes] = useState("180");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);

  async function refresh() {
    const version = ++requestVersion.current;
    const result = await rpc.call("status", { threadId });
    if (version !== requestVersion.current) return;
    setShare(result.share);
    setConfiguration({
      customHostname: result.customHostname,
      cloudflaredAvailable: result.cloudflaredAvailable,
      customConfigured: result.customConfigured,
    });
    if (!checkedTarget.current) {
      checkedTarget.current = true;
      if (result.share) {
        setMode(result.share.mode);
        setCheckingTarget(false);
      } else {
        // Opening the dialog is the opt-in check. Closed UI never probes Pinpoint.
        void rpc.call("reviewTarget", { threadId }).then((target) => {
          setTargetUrl(target.url);
          setMode((current) => current ?? (target.url ? "review" : "view"));
        }, () => setMode((current) => current ?? "view")).finally(() => setCheckingTarget(false));
      }
    }
  }

  function reportRefreshError(error: unknown) {
    announce(error instanceof Error ? error.message : "Could not load sharing settings.", true);
  }
  useEffect(() => {
    void refresh().catch(reportRefreshError);
    return () => { requestVersion.current++; };
  }, [threadId]);
  useShareSignals(() => void refresh().catch(reportRefreshError), threadId);
  const preparing = share !== null && !share.ready;
  useEffect(() => {
    const timer = window.setInterval(
      () => void refresh().catch(reportRefreshError),
      preparing ? PREPARING_REFRESH_MS : PANEL_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [threadId, preparing]);

  async function selectReview() {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    try {
      const target = await rpc.call("reviewTarget", { threadId });
      if (!target.url) throw new Error("Open a site in this thread's Pinpoint panel first.");
      setTargetUrl(target.url);
      setMode("review");
      announce("");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Pinpoint is unavailable.", true);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  function announce(text: string, isError = false) {
    setMessage(text);
    setMessageIsError(isError);
  }

  async function start() {
    if (operation.current || !configuration || !mode) return;
    operation.current = true;
    requestVersion.current++;
    const tunnelMode: TunnelMode = configuration.customHostname.trim() ? "custom" : "quick";
    setBusy(true);
    announce("");
    try {
      const result = await rpc.call("start", {
        threadId,
        durationMinutes: Number(durationMinutes),
        mode,
        tunnelMode,
      });
      setShare(result.share);
      announce(
        result.share.ready ? "Public viewer is ready." : "Publishing DNS…",
      );
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error), true);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function stop() {
    if (operation.current || !share) return;
    const shareId = share.id;
    operation.current = true;
    requestVersion.current++;
    setBusy(true);
    announce("");
    try {
      await rpc.call("revoke", { shareId });
      setShare((current) => current?.id === shareId ? null : current);
      announce("Share revoked.");
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error), true);
      throw error;
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  const statusMessage = (
    <p
      aria-live="polite"
      className={cn(
        "h-8 overflow-y-auto break-words text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
        messageIsError ? "text-destructive" : "text-muted-foreground",
      )}
      role="status"
      tabIndex={message ? 0 : undefined}
    >
      {message}
    </p>
  );

  if (share) {
    const remainingLabel = expiryLabel(share.expiresAt);
    return (
      <>
      <div className="min-h-0 space-y-5 overflow-y-auto p-4">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={cn(
              "size-2 rounded-full",
              share.ready
                ? "bg-success shadow-[0_0_0_4px_color-mix(in_srgb,var(--success)_12%,transparent)]"
                : "bg-muted-foreground/50",
            )}
          />
          <span className="font-medium text-foreground">
            {share.ready ? "Live" : "Preparing"}
          </span>
          <span className="ml-auto whitespace-nowrap text-muted-foreground">
            {share.mode === "review" ? "Review" : "View"}
            {" · "}
            {remainingLabel}
          </span>
        </div>

        <div className="space-y-5">
          <CopyField
            label="Public link"
            onCopied={() => announce("Link copied.")}
            onCopyFailed={() => announce("Could not copy the link.", true)}
            value={share.publicUrl}
          />
          <CopyField
            label="Access code"
            onCopied={() => announce("Access code copied.")}
            onCopyFailed={() => announce("Could not copy the access code.", true)}
            value={share.accessCode}
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            disabled={!share.ready}
            onClick={() => openUrl(share.publicUrl)}
            type="button"
          >
            Open viewer
            <Icon name="ExternalLink" />
          </Button>
          <RevokeConfirmation title={share.title} onConfirm={stop}>
            <Button aria-label="Revoke" className="text-destructive hover:text-destructive" disabled={busy} size="icon" type="button" variant="ghost">
              <Icon name={busy ? "Loading" : "CircleX"} className={busy ? "animate-spin" : undefined} />
            </Button>
          </RevokeConfirmation>
        </div>
        {statusMessage}
      </div>
      <ShareDialogFooter />
      </>
    );
  }

  if (!configuration) {
    return (
      <>
      <div
        className="flex min-h-32 items-center justify-center gap-2 p-4 text-muted-foreground"
        role="status"
      >
        <Icon name="Loading" className="size-4 animate-spin" />
        <span className="sr-only">Loading share settings</span>
        {statusMessage}
      </div>
      <ShareDialogFooter />
      </>
    );
  }

  const missingCustomConfiguration =
    Boolean(configuration.customHostname.trim()) && !configuration.customConfigured;
  const missingPinpointTarget = mode === "review" && !targetUrl;
  const sharingUnavailable =
    !mode ||
    !configuration.cloudflaredAvailable ||
    missingCustomConfiguration ||
    missingPinpointTarget;

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <div className="min-h-0 space-y-4 overflow-y-auto p-4">

      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground">Access</span>
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/20 p-1">
          <ChoiceButton
            active={mode === "view"}
            disabled={busy}
            label="Conversation"
            onClick={() => { setMode("view"); announce(""); }}
          />
          <ChoiceButton
            active={mode === "review"}
            disabled={busy || checkingTarget}
            label="Pinpoint review"
            onClick={() => void selectReview()}
          />
        </div>
      </div>

      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground">
          Duration
        </span>
        <DurationSelect
          onValueChange={setDurationMinutes}
          value={durationMinutes}
        />
      </div>

      {!configuration.cloudflaredAvailable && (
        <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning-text">
          <Icon name="Info" className="mt-0.5 size-3.5 shrink-0" />
          <p>
            Install <code className="font-mono">cloudflared</code>, then reopen this dialog.
          </p>
        </div>
      )}
      {missingCustomConfiguration && (
        <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning-text">
          <Icon name="Info" className="mt-0.5 size-3.5 shrink-0" />
          <p>
            Set the custom hostname and named tunnel token under Extensions →
            Session Share.
          </p>
        </div>
      )}
      {missingPinpointTarget && (
        <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning-text">
          <Icon name="Info" className="mt-0.5 size-3.5 shrink-0" />
          <p>
            Open the site in this thread&apos;s Pinpoint panel before creating
            a Review link.
          </p>
        </div>
      )}

      {statusMessage}
      </div>
      <ShareDialogFooter>
        <Button disabled={busy || sharingUnavailable} type="submit">
          {busy ? "Starting…" : "Start sharing"}
        </Button>
      </ShareDialogFooter>
    </form>
  );
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


function SessionShareOverlay() {
  const pluginId = experimental_usePluginId();
  const context = useBbContext();
  const opener = useRef<HTMLElement | null>(null);
  const outsideFocus = useRef<HTMLElement | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [viewport] = useState(() => window.matchMedia("(max-width: 767px), (pointer: coarse)"));
  const [isCompactViewport, setIsCompactViewport] = useState(viewport.matches);

  useEffect(() => {
    const update = () => setIsCompactViewport(viewport.matches);
    viewport.addEventListener("change", update);
    return () => viewport.removeEventListener("change", update);
  }, [viewport]);
  useEffect(() => {
    const remember = (event: Event) => {
      const target = event.target instanceof Element
        ? event.target.closest("button, a[href], input, select, textarea, [tabindex]") : null;
      if (target instanceof HTMLElement && target !== document.body
        && !target.closest('[role="menu"], [role="dialog"]')) {
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
      const request = (event as CustomEvent<OpenShareRequest>).detail;
      if (typeof request?.threadId !== "string" || !request.threadId) return;
      const target = request.returnFocusTo;
      // Compact menus may not link their trigger with aria-labelledby.
      opener.current = target instanceof HTMLElement && target !== document.body
        && !target.closest('[role="menu"], [role="dialog"]') ? target : outsideFocus.current;
      setThreadId(request.threadId);
      setOpen(true);
    };
    window.addEventListener(OPEN_SHARE, handler);
    return () => window.removeEventListener(OPEN_SHARE, handler);
  }, []);
  useEffect(() => { setOpen(false); }, [context.threadId]);

  if (!threadId) return null;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-bb-plugin={pluginId} data-bb-plugin-root="" data-bb-portaled-overlay="" className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content data-bb-plugin={pluginId} data-bb-plugin-root="" data-bb-portaled-overlay=""
          onCloseAutoFocus={(event) => {
            if (opener.current?.isConnected) {
              event.preventDefault();
              opener.current.focus();
            }
          }}
          className={cn("fixed z-[51] flex max-h-[90dvh] flex-col border border-border bg-background text-foreground shadow-lg outline-none",
            isCompactViewport ? "bottom-0 left-0 w-full rounded-t-md" : "left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md")}>
          <div className="border-b border-border px-4 py-3">
            <DialogPrimitive.Title className="text-sm font-semibold">Session Share</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">Share the conversation or collect app feedback.</DialogPrimitive.Description>
          </div>
          <SessionSharePanel key={threadId} threadId={threadId} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SetupGuide() {
  return <details className="group rounded-md border border-border bg-surface-recessed/70 p-3">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm [&::-webkit-details-marker]:hidden">
      Setup guide<Icon name="ChevronDown" className="size-4 shrink-0 transition-transform group-open:rotate-180" />
    </summary>
    <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm text-muted-foreground">
      <p>Install cloudflared on the BB server machine. Session Share never downloads or installs it. Set its path in Configuration if it is not on PATH.</p>
      <p>A configured custom hostname is used automatically. Otherwise, Session Share creates a temporary Cloudflare hostname. For a named tunnel, configure its token and route only the isolated viewer port, not BB.</p>
      <p>Open Session Share beside Scripts in a thread&apos;s ⋯ menu. Choose what to share and a duration, then Start sharing. Send the link and access code privately. Stored shares restore after restart; temporary hostnames may change.</p>
      <p>The dialog checks for an active Pinpoint preview and selects Review when one is available. Review requires a compatible Pinpoint installation and a site open in that thread. Session Share never installs or enables Pinpoint. <UrlLink href="/settings/plugins/pinpoint" className="underline">Pinpoint settings</UrlLink></p>
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
  app.slots.experimental_appOverlay({ id: "session-share", component: SessionShareOverlay });
  app.slots.experimental_threadAction({
    id: "session-share",
    title: "Session Share",
    icon: "session-share/share",
    group: "machine",
    item: ({ thread }) => ({
      label: "Session Share",
      icon: "session-share/share",
      run: () => {
        const active = document.activeElement;
        const triggerId = active?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
        const returnFocusTo = (triggerId ? document.getElementById(triggerId) : null)
          ?? (active instanceof HTMLElement ? active : null);
        const detail: OpenShareRequest = { threadId: thread.id, returnFocusTo };
        // Remember the trigger before the menu unmounts; open after it closes.
        setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_SHARE, { detail })), 0);
      },
    }),
  });
});
