// Share button, Share popover, and the page_share confirmation (T4).
import { useCallback, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { experimental_Icon as Icon, useRpc, type PluginAppBuilder, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { Access, PageDetail, PagesRpc, Share } from "../../contract.js";
import type { ShareConfirmPayload, ShareStatus } from "../../server/share/service.js";
import { pageTag, refreshCached, useCachedQuery, usePageDetail } from "../data.js";
import { focusRing, messageOf } from "../ui.js";

/** Must match CONFIRM_RENDERER_ID in server/share/index.ts. */
export const CONFIRM_RENDERER_ID = "page-share-confirm";
const ACCESS_LABEL: Record<Access, string> = { restricted: "Restricted", password: "Password", link: "Anyone with the link" };
const ACCESS_HINT: Record<Access, string> = { restricted: "Verified emails or domains", password: "Anyone with the password", link: "Public to anyone with the URL" };
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const menuItem = "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-state-hover data-[disabled]:opacity-50";
const smallButton = `inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium hover:bg-state-hover disabled:cursor-default disabled:opacity-50 ${focusRing}`;
const primaryButton = `inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-50 ${focusRing}`;
/**
 * Portaled content lands in document.body, outside the plugin mount. The plugin stylesheet is scoped to
 * `[data-bb-plugin="pages"]`, so each portaled root carries the scope itself (as agent-profiles does).
 */
const PORTAL_SCOPE = { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", "data-bb-plugin": "pages" } as const;

function ShareGlyph({ className = "size-3.5" }: { className?: string }) {
  return <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v13" />
  </svg>;
}
function GlobeGlyph({ className = "size-3.5" }: { className?: string }) {
  return <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>;
}

/** getShare for one page, from the window cache. Refreshes quietly on `pages-changed` for that page. A null pageId stays idle. */
function useShareStatus(pageId: string | null) {
  const rpc = useRpc<PagesRpc>();
  const key = pageId ? `getShare|${pageId}` : null;
  const state = useCachedQuery<ShareStatus>(key, async () => {
    if (!pageId) return { status: "idle" };
    try {
      return { status: "ready", value: await rpc.call("getShare", { pageId }) };
    } catch (error) {
      return { status: "error", message: messageOf(error, "Share status could not load.") };
    }
  }, () => pageId ? [pageTag(pageId)] : []);
  const reload = useCallback(() => { if (key) refreshCached(key); }, [key]);
  return { state, reload };
}

/**
 * The Share control. Compact: an icon (a globe when anyone with the link can view) with a status dot.
 * Otherwise a small "Share" button. A null pageId (a live file) takes a snapshot through onNeedsPage first.
 * `share` comes from the page detail the caller already has, so the button itself costs no request;
 * the popover loads the full share status only when it opens.
 */
export function ShareButton({ pageId, share = null, onNeedsPage, compact = false }: { pageId: string | null; share?: Pick<Share, "access" | "status"> | null; onNeedsPage?: () => Promise<string>; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const id = pageId ?? snapshotId;

  const onOpenChange = async (next: boolean) => {
    setOpen(next);
    if (!next || id || !onNeedsPage) return;
    setSnapshot({ busy: true, error: null });
    try {
      setSnapshotId(await onNeedsPage());
      setSnapshot({ busy: false, error: null });
    } catch (error) {
      setSnapshot({ busy: false, error: messageOf(error, "The page could not be saved.") });
    }
  };

  const label = !share ? "Share" : share.status === "error" ? "Share: needs attention" : `Shared: ${ACCESS_LABEL[share.access]}`;
  const dot = share ? <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${share.status === "error" ? "bg-destructive" : "bg-success"}`} /> : null;
  const glyph = share?.access === "link" ? <GlobeGlyph /> : <ShareGlyph />;
  const trigger = compact
    ? <button type="button" aria-label={label} title={label} className={`relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-hover ${focusRing}`}>
      {glyph}{dot ? <span className="absolute right-0.5 top-0.5 flex">{dot}</span> : null}
    </button>
    : <button type="button" aria-label={label} title={label} className={`inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 ${focusRing}`}>
      {glyph}<span>{share ? "Shared" : "Share"}</span>{dot}
    </button>;

  return <Popover.Root open={open} onOpenChange={(next) => void onOpenChange(next)}>
    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Content {...PORTAL_SCOPE} aria-label="Share page" align="end" sideOffset={6} collisionPadding={8} style={{ zIndex: 75 }} className="w-[300px] max-w-[calc(100vw-16px)] rounded-[10px] border border-border bg-popover text-[13px] text-popover-foreground shadow-md outline-none">
        {id ? <PageSharePanel pageId={id} />
          : <p role={snapshot.error ? "alert" : "status"} className={`px-3.5 py-3 text-xs ${snapshot.error ? "text-destructive" : "text-muted-foreground"}`}>{snapshot.error ?? "Saving a snapshot of this file…"}</p>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function PageSharePanel({ pageId }: { pageId: string }) {
  const { state } = usePageDetail(pageId, null);
  if (state.status === "ready") return <SharePopover detail={state.value} />;
  const message = state.status === "error" ? state.message : state.status === "missing" ? "This page no longer exists." : "Loading…";
  return <p role={state.status === "error" ? "alert" : "status"} className="px-3.5 py-3 text-xs text-muted-foreground">{message}</p>;
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="border-t border-border px-3.5 py-3 first:border-t-0">
    <div className="flex min-h-6 items-center justify-between gap-2 font-medium">{title}{action}</div>
    {children}
  </section>;
}

/** A value box with an optional trailing action, like the mockup's link row. */
function ValueRow({ children, action, label }: { children: ReactNode; action?: ReactNode; label: string }) {
  return <div className="mt-2 flex items-center gap-1.5">
    <code aria-label={label} className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs">{children}</code>
    {action}
  </div>;
}

/** Editable domain and email chips for Restricted access. Enter, comma, or blur adds a chip. */
function Chips({ values, onChange, disabled }: { values: string[]; onChange: (next: string[]) => void; disabled: boolean }) {
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const add = () => {
    const value = text.trim().toLowerCase().replace(/^@/u, "");
    if (!value) return;
    if (!DOMAIN.test(value) && !EMAIL.test(value)) { setInvalid(true); return; }
    setText(""); setInvalid(false);
    if (!values.includes(value)) onChange([...values, value]);
  };
  return <div className={`mt-2 flex min-h-8 flex-wrap items-center gap-1 rounded-md border px-1.5 py-1 ${invalid ? "border-destructive" : "border-border"}`}>
    {values.map((value) => <span key={value} className="inline-flex h-5 items-center gap-0.5 rounded bg-muted pl-1.5 pr-0.5 text-xs">
      {value}
      <button type="button" aria-label={`Remove ${value}`} disabled={disabled} onClick={() => onChange(values.filter((item) => item !== value))} className={`inline-flex size-4 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground ${focusRing}`}>
        <Icon name="X" aria-hidden className="size-3" />
      </button>
    </span>)}
    <input
      aria-label="Add a domain or email" aria-invalid={invalid} placeholder={values.length ? "Add…" : "example.com or name@company.com"} disabled={disabled}
      value={text} onChange={(event) => { setText(event.target.value); setInvalid(false); }} onBlur={add}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === ",") { event.preventDefault(); add(); }
        if (event.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
      }}
      className="h-5 min-w-24 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
    />
  </div>;
}

function Choice<T extends string>({ label, value, options, onSelect, disabled }: { label: string; value: T; options: Array<{ value: T; label: string; hint?: string }>; onSelect: (value: T) => void; disabled?: boolean }) {
  const current = options.find((option) => option.value === value);
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild disabled={disabled}>
      <button type="button" aria-label={`${label}: ${current?.label ?? ""}`} className={`mt-1.5 flex h-7 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-2 text-left text-[13px] hover:bg-state-hover disabled:cursor-default disabled:opacity-60 data-[state=open]:bg-state-hover ${focusRing}`}>
        <span className="min-w-0 truncate">{current?.label}</span><Icon name="ChevronDown" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content {...PORTAL_SCOPE} align="start" sideOffset={4} collisionPadding={8} style={{ zIndex: 76 }} className="w-[272px] max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
        <DropdownMenu.RadioGroup value={value} onValueChange={(next) => onSelect(next as T)} className="max-h-64 overflow-y-auto">
          {options.map((option) => <DropdownMenu.RadioItem key={option.value} value={option.value} className={menuItem}>
            <span className="flex w-3.5 shrink-0 justify-center"><DropdownMenu.ItemIndicator><Icon name="Check" aria-hidden className="size-3.5" /></DropdownMenu.ItemIndicator></span>
            <span className="min-w-0 truncate">{option.label}</span>
            {option.hint ? <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{option.hint}</span> : null}
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

type Pending = { kind: "share"; access: Access } | { kind: "public" } | { kind: "unshare" };
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value) => b.includes(value));
const split = (values: string[]) => ({ allowedDomains: values.filter((value) => !value.includes("@")), allowedEmails: values.filter((value) => value.includes("@")) });

/** Share popover body: link, access, shared version, and one quiet status line. */
export function SharePopover({ detail }: { detail: PageDetail }) {
  const rpc = useRpc<PagesRpc>();
  const pageId = detail.page.id;
  const { state, reload } = useShareStatus(pageId);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "muted" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draftAccess, setDraftAccess] = useState<Access | null>(null);
  const [chips, setChips] = useState<string[] | null>(null);
  const [draftFollow, setDraftFollow] = useState<string>("latest");

  if (state.status !== "ready") {
    return <p role={state.status === "error" ? "alert" : "status"} className="px-3.5 py-3 text-xs text-muted-foreground">{state.status === "error" ? state.message : "Loading…"}</p>;
  }
  const { configured, share, defaults } = state.value;
  const access: Access | null = draftAccess ?? share?.access ?? null;
  const restrictedChips = chips ?? (share?.access === "restricted" ? [...share.allowedDomains, ...share.allowedEmails] : defaults.allowedDomains);
  const follow = share?.follow ?? draftFollow;
  const versions = [...detail.versions].sort((a, b) => b.n - a.n);
  const liveN = share?.liveVersionId ? detail.versions.find((version) => version.id === share.liveVersionId)?.n : null;

  const run = async (label: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(label); setNotice(null); setPending(null);
    try {
      await action();
      setDraftAccess(null); setChips(null);
      if (done) setNotice({ tone: "muted", text: done });
    } catch (error) {
      setNotice({ tone: "error", text: messageOf(error, "Sharing failed.") });
    } finally {
      setBusy(null);
      void reload();
    }
  };
  const shareWith = (next: Access, lists = split(restrictedChips)) => run(share ? "Updating access…" : "Sharing…", () => rpc.call("sharePage", {
    pageId, access: next, ...(next === "restricted" ? lists : {}), ...(share ? {} : { follow }),
  }));
  const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => setNotice({ tone: "muted", text: `${what} copied.` }), () => setNotice({ tone: "error", text: "Copy failed." }));

  const pickAccess = (next: Access | "none") => {
    setNotice(null); setPending(null);
    if (next === "none") { if (share) setPending({ kind: "unshare" }); else setDraftAccess(null); return; }
    if (!share) { setDraftAccess(next); return; }
    if (next === share.access && next !== "restricted") { setDraftAccess(null); return; }
    setDraftAccess(next);
    if (next === "link") { setPending({ kind: "public" }); return; }
    if (next === "password") void shareWith("password");
    // Restricted waits for Apply, so the owner can check the chips first.
  };
  const initial: Access = draftAccess ?? defaults.access;
  const canShare = configured && !busy && (initial !== "restricted" || restrictedChips.length > 0);
  const restrictedDirty = share !== null && access === "restricted" && (share.access !== "restricted" || !sameList(restrictedChips, [...share.allowedDomains, ...share.allowedEmails]));

  // ---- Link row
  const linkSection = <Section title="Share page" action={share ? <button type="button" className={smallButton} onClick={() => void copy(share.url, "Link")}><Icon name="Copy" aria-hidden className="size-3" />Copy link</button> : null}>
    {share
      ? <ValueRow label="Share link">{share.url}</ValueRow>
      : <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">No link yet</span>
        <button type="button" className={primaryButton} disabled={!canShare} onClick={() => setPending({ kind: "share", access: initial })}><ShareGlyph className="size-3" />Share</button>
      </div>}
  </Section>;

  // ---- Access
  const accessOptions: Array<{ value: Access | "none"; label: string; hint?: string }> = [
    { value: "none", label: "Not shared" },
    ...(["restricted", "password", "link"] as const).map((value) => ({ value, label: ACCESS_LABEL[value], hint: value === "link" ? "Public" : undefined })),
  ];
  const accessSection = <Section title="Access">
    <Choice label="Access" value={access ?? "none"} options={accessOptions} onSelect={pickAccess} disabled={!configured || busy !== null} />
    <p className="mt-1 text-xs text-muted-foreground">{access ? ACCESS_HINT[access] : `Share uses ${ACCESS_LABEL[defaults.access].toLowerCase()} by default.`}</p>
    {(access === "restricted" || (!share && initial === "restricted")) ? <>
      <Chips values={restrictedChips} onChange={setChips} disabled={busy !== null} />
      {restrictedDirty ? <div className="mt-2 flex justify-end gap-1.5">
        <button type="button" className={smallButton} onClick={() => { setDraftAccess(null); setChips(null); }}>Cancel</button>
        <button type="button" className={primaryButton} disabled={restrictedChips.length === 0 || busy !== null} onClick={() => void shareWith("restricted")}>Apply</button>
      </div> : null}
    </> : null}
    {share?.access === "password" && access === "password" ? <ValueRow label="Password" action={<>
      <button type="button" className={smallButton} disabled={busy !== null} onClick={() => void run("Copying…", async () => { const { password } = await rpc.call("revealPassword", { pageId }); await navigator.clipboard.writeText(password); }, "Password copied.")}>
        <Icon name="Copy" aria-hidden className="size-3" />Copy
      </button>
      <button type="button" aria-label="Rotate password" title="Rotate password" className={smallButton} disabled={busy !== null} onClick={() => void run("Rotating password…", () => rpc.call("rotatePassword", { pageId }), "New password set. Copy it again.")}>
        <Icon name="RotateCcw" aria-hidden className="size-3" />
      </button>
    </>}>••••••••••••</ValueRow> : null}
  </Section>;

  // ---- Shared version
  const followOptions = [{ value: "latest", label: "Latest (follows new versions)" }, ...versions.map((version) => ({ value: version.id, label: `Pin v${version.n}${version.label ? ` · ${version.label}` : ""}` }))];
  const versionSection = <Section title="Shared version">
    <Choice label="Shared version" value={follow} options={followOptions} disabled={busy !== null}
      onSelect={(next) => { if (!share) setDraftFollow(next); else if (next !== share.follow) void run("Publishing…", () => rpc.call("setFollow", { pageId, follow: next })); }} />
    <p className="mt-1 text-xs text-muted-foreground">{follow === "latest" ? `Pin a version to stop the link from changing.` : "New versions stay private until you choose Latest."}</p>
  </Section>;

  // ---- Inline confirm (first share, going public, unsharing) or one quiet status line
  let footer: ReactNode = null;
  if (pending) {
    const text = pending.kind === "unshare" ? "Delete the site? The link stops working."
      : pending.kind === "public" || (pending.kind === "share" && pending.access === "link") ? "Anyone with the link can view this page."
        : `Share with ${pending.access === "restricted" ? restrictedChips.join(", ") : "a password"}?`;
    const confirm = () => {
      if (pending.kind === "unshare") void run("Unsharing…", () => rpc.call("unsharePage", { pageId }));
      else if (pending.kind === "public") void shareWith("link");
      else void shareWith(pending.access);
    };
    footer = <div role="alert" className="flex items-center gap-1.5 text-xs">
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" className={smallButton} onClick={() => { setPending(null); setDraftAccess(null); }}>Cancel</button>
      <button type="button" className={pending.kind === "unshare" ? `${smallButton} text-destructive` : primaryButton} onClick={confirm}>{pending.kind === "unshare" ? "Delete" : pending.kind === "share" && pending.access !== "link" ? "Share" : "Make public"}</button>
    </div>;
  } else if (!configured) {
    footer = <p role="status" className="text-xs text-muted-foreground">Here.now key not set. Add it in Settings → Plugins → Pages.</p>;
  } else if (busy || share?.status === "publishing") {
    footer = <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Spinner" aria-hidden className="size-3 animate-spin" />{busy ?? "Publishing…"}</p>;
  } else if (notice) {
    footer = <p role={notice.tone === "error" ? "alert" : "status"} className={`text-xs ${notice.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>{notice.text}</p>;
  } else if (share?.status === "error") {
    footer = <p role="alert" className="text-xs text-destructive">{share.lastError ?? "Sharing failed."}{" "}
      <button type="button" className={`cursor-pointer text-foreground underline underline-offset-2 ${focusRing}`} onClick={() => void run("Retrying…", () => rpc.call("setFollow", { pageId, follow: share.follow }))}>Retry</button>
    </p>;
  } else if (share) {
    footer = <p role="status" className="text-xs text-muted-foreground">Live{liveN ? ` · v${liveN}` : ""}{share.follow === "latest" ? " · follows new versions" : " · pinned"}</p>;
  }

  return <div>
    {linkSection}
    {accessSection}
    {versionSection}
    {footer ? <div className="border-t border-border px-3.5 py-2.5">{footer}</div> : null}
  </div>;
}

const isPayload = (value: unknown): value is ShareConfirmPayload =>
  Boolean(value && typeof value === "object" && !Array.isArray(value) && "title" in value && "access" in value && typeof value.access === "string" && value.access in ACCESS_LABEL);

/** The page_share (and in-thread `bb pages share`) confirmation. Same sections as the popover, read-only. */
export function ShareConfirm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const [busy, setBusy] = useState(false);
  const payload = isPayload(interaction.payload) ? interaction.payload : null;
  if (!payload) return <p role="alert" className="text-sm text-destructive">This share request is malformed.</p>;
  const who = [...(payload.allowedDomains ?? []), ...(payload.allowedEmails ?? [])];
  const answer = async (confirmed: boolean) => {
    setBusy(true);
    try { if (confirmed) await submit({ confirmed: true }); else await cancel(); } finally { setBusy(false); }
  };
  return <div className="w-full max-w-[360px] rounded-[10px] border border-border bg-background text-[13px]">
    <Section title={`Share “${payload.title}”`} action={<span className="text-xs tabular-nums text-muted-foreground">v{payload.versionN}</span>}>
      {payload.url ? <ValueRow label="Share link">{payload.url}</ValueRow> : <p className="mt-1 text-xs text-muted-foreground">{payload.adoptSlug ? `Adopts the existing site ${payload.adoptSlug}; its link stays the same.` : "Creates a new Here.now link."}</p>}
    </Section>
    <Section title="Access">
      <p className="mt-1.5 flex items-center gap-1.5">{payload.access === "link" ? <GlobeGlyph /> : null}{ACCESS_LABEL[payload.access]}<span className="text-xs text-muted-foreground">· {ACCESS_HINT[payload.access]}</span></p>
      {payload.access === "restricted" ? <div className="mt-2 flex flex-wrap gap-1">{who.map((value) => <span key={value} className="inline-flex h-5 items-center rounded bg-muted px-1.5 text-xs">{value}</span>)}</div> : null}
      {payload.replaces && payload.replaces !== ACCESS_LABEL[payload.access].toLowerCase() ? <p className="mt-1.5 text-xs text-muted-foreground">Now: {payload.replaces}</p> : null}
      {payload.access === "password" ? <p className="mt-1.5 text-xs text-muted-foreground">Copy the password from the Share popover.</p> : null}
    </Section>
    <Section title="Shared version">
      <p className="mt-1.5 text-xs text-muted-foreground">{payload.follow === "latest" ? "Latest. The link follows new versions of this page." : `Pinned to v${payload.follow}. New versions stay private.`}</p>
    </Section>
    <div className="flex items-center gap-1.5 border-t border-border px-3.5 py-2.5 text-xs">
      <span className={`min-w-0 flex-1 ${payload.goesPublic ? "font-medium text-foreground" : "text-muted-foreground"}`}>{payload.goesPublic ? "Anyone with the link can view this page." : payload.access === "link" ? "The link is already public." : payload.access === "password" ? "Only people with the password can view it." : "Only these people can view it, after signing in."}</span>
      <button type="button" className={smallButton} disabled={busy} onClick={() => void answer(false)}>Cancel</button>
      <button type="button" className={primaryButton} disabled={busy} onClick={() => void answer(true)}>{payload.goesPublic ? "Make public" : "Share"}</button>
    </div>
  </div>;
}

/** T3 calls this once inside definePluginApp. */
export function registerShareSlots(app: PluginAppBuilder) {
  app.slots.pendingInteraction({ id: CONFIRM_RENDERER_ID, component: ShareConfirm });
}
