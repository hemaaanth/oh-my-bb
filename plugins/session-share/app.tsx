import { useCallback, useEffect, useRef, useState } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import {
  definePluginApp,
  experimental_Icon as BbIcon,
  experimental_copyToClipboard,
  experimental_usePluginId,
  UrlLink,
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
export const PANEL_REFRESH_MS = 30_000;
export const SETTINGS_REFRESH_MS = 60_000;
export const PREPARING_REFRESH_MS = 15_000;

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
  pinpointTargetUrl: string | null;
}


function ChoiceButton({
  active,
  description,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <Button
      aria-pressed={active}
      className={cn(
        "h-auto min-w-0 justify-start rounded-md px-3 py-2 text-left shadow-none",
        active
          ? "bg-background text-foreground shadow-sm hover:bg-background"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
      variant="ghost"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block truncate text-[11px] font-normal text-muted-foreground">
          {description}
        </span>
      </span>
    </Button>
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
  const scope = { "data-bb-plugin": pluginId, "data-bb-plugin-root": "", "data-bb-portaled-overlay": "" };
  return <AlertDialogPrimitive.Root open={open} onOpenChange={setOpen}>
    <AlertDialogPrimitive.Trigger asChild>{children}</AlertDialogPrimitive.Trigger>
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay {...scope} className="fixed inset-0 z-[70] bg-black/40" />
      <AlertDialogPrimitive.Content {...scope} className="fixed bottom-0 left-0 z-[71] w-full rounded-t-md border border-border bg-background p-4 text-foreground shadow-lg sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-md">
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

function SessionSharePanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { openUrl } = useBbNavigate();
  const [share, setShare] = useState<ShareStatus | null>(null);
  const [configuration, setConfiguration] =
    useState<ConfigurationState | null>(null);
  const [mode, setMode] = useState<ShareMode>("view");
  const [tunnelMode, setTunnelMode] = useState<TunnelMode | null>(null);
  const [durationMinutes, setDurationMinutes] = useState("180");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);

  async function refresh() {
    const result = await rpc.call("status", { threadId });
    setShare(result.share);
    setConfiguration((current) => ({
      customHostname: result.customHostname,
      cloudflaredAvailable: result.cloudflaredAvailable,
      customConfigured: result.customConfigured,
      pinpointTargetUrl: current?.pinpointTargetUrl ?? result.pinpointTargetUrl,
    }));
    setTunnelMode((current) =>
      current ?? (result.customConfigured ? "custom" : "quick"),
    );
  }

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [threadId]);
  useShareSignals(() => void refresh().catch(() => undefined), threadId);
  const preparing = share !== null && !share.ready;
  useEffect(() => {
    const timer = window.setInterval(
      () => void refresh().catch(() => undefined),
      preparing ? PREPARING_REFRESH_MS : PANEL_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [threadId, preparing]);

  async function selectReview() {
    setBusy(true);
    try {
      const target = await rpc.call("reviewTarget", { threadId });
      if (!target.url) throw new Error("Open a site in this thread's Pinpoint panel first.");
      setConfiguration((current) => current ? { ...current, pinpointTargetUrl: target.url } : current);
      setMode("review");
      announce("");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Pinpoint is unavailable.", true);
    } finally {
      setBusy(false);
    }
  }
  function announce(text: string, isError = false) {
    setMessage(text);
    setMessageIsError(isError);
  }

  async function start() {
    if (!tunnelMode) return;
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
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    announce("");
    try {
      await rpc.call("stop", { threadId });
      setShare(null);
      announce("Sharing stopped. The public link is no longer active.");
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error), true);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  const statusMessage = message ? (
    <p
      aria-live="polite"
      className={cn(
        "text-xs",
        messageIsError ? "text-destructive" : "text-muted-foreground",
      )}
      role="status"
    >
      {message}
    </p>
  ) : null;

  if (share) {
    const remainingLabel = expiryLabel(share.expiresAt);
    return (
      <div className="space-y-5">
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
    );
  }

  if (!configuration || !tunnelMode) {
    return (
      <div
        className="flex min-h-64 items-center justify-center text-muted-foreground"
        role="status"
      >
        <Icon name="Loading" className="size-4 animate-spin" />
        <span className="sr-only">Loading share settings</span>
      </div>
    );
  }

  const missingCustomConfiguration =
    tunnelMode === "custom" && !configuration.customConfigured;
  const missingPinpointTarget =
    mode === "review" && !configuration.pinpointTargetUrl;
  const sharingUnavailable =
    !configuration.cloudflaredAvailable ||
    missingCustomConfiguration ||
    missingPinpointTarget;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >

      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground">Access</span>
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/20 p-1">
          <ChoiceButton
            active={mode === "view"}
            description="Watch the session"
            label="View"
            onClick={() => setMode("view")}
          />
          <ChoiceButton
            active={mode === "review"}
            description={
              configuration.pinpointTargetUrl
                ? new URL(configuration.pinpointTargetUrl).host
                : "Use Pinpoint"
            }
            disabled={busy}
            label="Review"
            onClick={() => void selectReview()}
          />
        </div>
      </div>

      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground">Tunnel</span>
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/20 p-1">
          <ChoiceButton
            active={tunnelMode === "custom"}
            description={configuration.customHostname || "Stable hostname"}
            label="Custom"
            onClick={() => setTunnelMode("custom")}
          />
          <ChoiceButton
            active={tunnelMode === "quick"}
            description="Changes on restart"
            label="Quick"
            onClick={() => setTunnelMode("quick")}
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
            Install <code className="font-mono">cloudflared</code> on this machine,
            then reopen this panel.
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

      <div className="flex justify-end">
        <Button disabled={busy || sharingUnavailable} type="submit">
          {busy ? "Starting tunnel…" : "Start sharing"}
        </Button>
      </div>
      {statusMessage}
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
    <section className="space-y-4">
      <h2 className="text-sm font-medium">Credentials</h2>
      <div className="overflow-hidden rounded-md border border-border bg-surface-recessed/70">
        <div className="flex items-center justify-between gap-4 border-b border-border p-3">
          <p className="text-sm font-medium">Shared sessions</p>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {shares.length}
          </span>
        </div>

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
      </div>
      <p aria-live="polite" className={cn("text-xs text-muted-foreground", !message && "sr-only")}>
        {message}
      </p>
    </section>
  );
}


function SessionShareHeaderAction({ threadId, isCompactViewport }: { threadId: string; isCompactViewport: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const pluginId = experimental_usePluginId();
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<ShareStatus | null>(null);

  // The indicator only needs this thread's share: read it on mount and when
  // the dialog closes, then follow realtime signals. While the dialog is open
  // its panel owns refreshing.
  const refresh = useCallback(
    () =>
      void rpc
        .call("share", { threadId })
        .then((result) => setShare(result.share))
        .catch(() => undefined),
    [rpc, threadId],
  );
  useEffect(() => {
    if (!open) refresh();
  }, [open, refresh]);
  useShareSignals(() => {
    if (!open) refresh();
  }, threadId);
  const preparing = share !== null && !share.ready;
  useEffect(() => {
    if (open || !preparing) return;
    const timer = window.setInterval(refresh, PREPARING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [open, preparing, refresh]);

  const liveMode = share?.ready ? share.mode : null;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
      <Button
        aria-label={
          liveMode === "review"
            ? "Session Share: live review link"
            : liveMode === "view"
              ? "Session Share: live view-only link"
              : "Session Share"
        }
        className="relative h-7 w-7 text-muted-foreground"
        size="icon"
        variant="ghost"
      >
        <BbIcon name="session-share/share" />
        {liveMode && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute right-0.5 top-0.5 size-1.5 rounded-full ring-2 ring-background",
              liveMode === "review" ? "bg-warning" : "bg-success",
            )}
          />
        )}
      </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-bb-plugin={pluginId} data-bb-plugin-root="" data-bb-portaled-overlay="" className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content data-bb-plugin={pluginId} data-bb-plugin-root="" data-bb-portaled-overlay=""
          className={cn("fixed z-[51] flex max-h-[90dvh] flex-col border border-border bg-background text-foreground shadow-lg",
            isCompactViewport ? "bottom-0 left-0 w-full rounded-t-md" : "left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md")}>
          <div className="border-b border-border px-4 py-3">
            <DialogPrimitive.Title className="text-sm font-semibold">Session Share</DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">Share a temporary viewer or Pinpoint review.</DialogPrimitive.Description>
          </div>
          <div className="min-h-0 overflow-y-auto p-4"><SessionSharePanel key={threadId} threadId={threadId} /></div>
          <div className="flex shrink-0 justify-end border-t border-border p-3">
            <DialogPrimitive.Close asChild><Button variant="outline">Done</Button></DialogPrimitive.Close>
          </div>
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
      <p>Quick mode creates a temporary Cloudflare hostname. Custom mode uses your existing named tunnel. Configure its token and a subdomain such as share.example.com. Route only the isolated viewer port, not BB.</p>
      <p>Open Session Share in a thread header. Choose View, a tunnel and a duration. Send the link and access code privately. Revoke a stored share to end access. Stored links restore after restart; Quick hostnames may change.</p>
      <p>Review is optional and runs only when selected or when restoring an existing Review share. It requires a compatible Pinpoint installation and a site already open in that thread. <UrlLink href="/settings/plugins/pinpoint" className="underline">Pinpoint settings</UrlLink></p>
      <p>Access codes remain in the local plugin database so owners can copy them again. Guest cookies expire after four hours or at the share expiry, whichever comes first. Until revoked links have no automatic share expiry.</p>
    </div>
  </details>;
}

function MoreSettings() {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium">More</h2>
      <SetupGuide />
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "credentials", component: SessionShareSettings });
  app.slots.settingsSection({ id: "more", component: MoreSettings });
  app.slots.experimental_threadHeaderAction({
    id: "session-share",
    title: "Session Share",
    component: SessionShareHeaderAction,
  });
});
