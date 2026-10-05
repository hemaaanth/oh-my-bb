// Settings section ported from the core Account Pooler (account-pool), MIT, Michael Yong 2026.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { FxIcon, GatewayChatGPTIcon, GatewayClaudeIcon, NanocodexIcon } from "./provider-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { ResourceRowDetailChevron } from "@/components/ui/resource-list";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type {
  AccountSummary,
  AccountPoolConfig,
  AccountPoolConfigSetInput,
  FamilyQuota,
  KeyAddInput,
  LimitWindow,
  ModelFamily,
  PoolProvider,
  PoolStatus,
  RoutingTarget,
} from "./src/contracts.js";
import {
  MODEL_GATEWAY_ACCOUNTS_CHANGED,
  MODEL_GATEWAY_CONFIG_CHANGED,
  MODEL_GATEWAY_ROUTE_CHANGED,
} from "./src/realtime.js";
import type { accountPoolRpcContract } from "./src/rpc.js";
import {
  HARNESSES,
  KEY_LABEL,
  UPSTREAM_KINDS,
  UPSTREAM_TITLES,
  upstreamKind,
  type UpstreamKind,
} from "./src/upstream-kind.js";

type Harness = (typeof HARNESSES)[number];
type KeyKind = KeyAddInput["kind"];
type SetupTarget = "acp-omp" | "acp-fx" | "acp-nanocodex" | "pi";

type Route = {
  harness: Harness;
  upstreamKind: UpstreamKind | null;
  accountLabel: string | null;
  model: string | null;
  chainIndex: number;
  chain: string[];
  stickyUntil: number | null;
  autoModel: string | null;
  auto: string | null;
  fallbackCause: FallbackCause | null;
};

type FallbackCause = {
  upstreamId: string;
  upstreamLabel: string;
  category: "transport" | "authentication" | "rate-limit" | "availability";
  status: number;
  message: string;
  at: number;
};

const HARNESS_TITLES: Record<Harness, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "acp-omp": "omp",
  "acp-fx": "FX",
  "acp-nanocodex": "nanocodex",
  pi: "Pi",
};

/** Plain name of the upstream that served a route: a compatible key goes by its label. */
function upstreamName(
  kind: UpstreamKind | null,
  label: string | null,
): string {
  if (kind === null) return label ?? "Gateway";
  return kind.endsWith("-compatible-key")
    ? (label ?? UPSTREAM_TITLES[kind])
    : UPSTREAM_TITLES[kind];
}

/** `auto → claude-opus-5-5 (jev 0.82)` when Jev changed the model. */
function autoPick(autoModel: string | null, reason: string | null): string {
  return `auto → ${autoModel}${reason === null ? "" : ` (${reason})`}`;
}

/** Shows the thread's route on every gateway thread; highlighted on a fallback or a Jev pick. */
function RouteBadge({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const [route, setRoute] = useState<Route | null>(null);
  const load = useCallback(() => {
    rpc.call("thread.route", { threadId }).then(setRoute, () => setRoute(null));
  }, [rpc, threadId]);
  useEffect(load, [load]);
  useRealtime(MODEL_GATEWAY_ROUTE_CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId)
      load();
  });
  if (route === null) return null;
  const upstream = upstreamName(route.upstreamKind, route.accountLabel);
  const title = [
    `Model Gateway route for ${HARNESS_TITLES[route.harness]}: ${route.chain.join(" → ")}`,
    `Now on step ${route.chainIndex + 1}: ${upstream}${route.accountLabel === null || route.accountLabel === upstream ? "" : ` (${route.accountLabel})`}`,
    route.stickyUntil !== null && `Stays there until ${clock(route.stickyUntil)}`,
    route.auto !== null && `Jev: ${route.auto}`,
    route.fallbackCause !== null &&
      `Fallback: ${route.fallbackCause.upstreamLabel} returned ${route.fallbackCause.category} (HTTP ${route.fallbackCause.status}) at ${clock(route.fallbackCause.at)}\n${route.fallbackCause.message}`,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Badge
      variant={
        route.chainIndex > 0 || route.autoModel !== null
          ? "secondary"
          : "outline"
      }
      title={title}
    >
      {upstream} ·{" "}
      {route.autoModel === null
        ? (route.model ?? "unknown model")
        : autoPick(route.autoModel, route.auto)}
    </Badge>
  );
}

interface RoutingState {
  enabled: Record<RoutingTarget, boolean>;
  blockedBy: string | null;
  setup: Record<SetupTarget, string>;
  ladders: Record<Harness, string[]>;
}
interface ChainOption {
  entry: string;
  label: string;
  blocked: string | null;
}
interface LiveState {
  threads: Array<{
    threadId: string;
    harness: Harness;
    entryIndex: number;
    entry: string | null;
    upstreamKind: UpstreamKind | null;
    upstreamLabel: string | null;
    model: string | null;
    autoModel: string | null;
    autoReason: string | null;
    stickyUntil: number | null;
    fallbackCause: FallbackCause | null;
    usedAt: number;
  }>;
  holds: Array<{
    accountId: string;
    label: string;
    upstreamKind: UpstreamKind;
    until: number;
  }>;
}
interface LoginStep {
  sessionId: string;
  authorizeUrl: string;
}
interface CodexLoginStep {
  sessionId: string;
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  intervalMs: number;
}
type DrawerState =
  | { kind: "account" | "priority" | "remove"; accountId: string }
  | { kind: "claude-login" | "codex-login" | "api-key" | "live" }
  | { kind: "route"; harness: Harness }
  | { kind: "setup"; target: SetupTarget }
  | null;

type ConfigField =
  "anthropicUpstreamBaseUrl" | "codexUpstreamBaseUrl" | "switchThreshold";

interface ConfigDrafts {
  anthropicUpstreamBaseUrl: string;
  codexUpstreamBaseUrl: string;
  switchThreshold: string;
}

interface ConfigErrors {
  anthropicUpstreamBaseUrl: string | null;
  codexUpstreamBaseUrl: string | null;
  switchThreshold: string | null;
}

interface KeyDraft {
  kind: KeyKind;
  label: string;
  baseUrl: string;
  apiKey: string;
}

const KEY_KINDS: Array<{
  kind: KeyKind;
  title: string;
  description: string;
  needsBaseUrl: boolean;
}> = [
  {
    kind: "claude-key",
    title: "Anthropic API key",
    description: "Uses the Anthropic upstream base URL.",
    needsBaseUrl: false,
  },
  {
    kind: "anthropic-compatible-key",
    title: "Anthropic-compatible key",
    description: "A Messages API vendor, for example Kimi or GLM.",
    needsBaseUrl: true,
  },
  {
    kind: "responses-compatible-key",
    title: "Responses-compatible key",
    description: "A Responses API vendor, for example OpenAI or OpenRouter.",
    needsBaseUrl: true,
  },
];
const ROUTING_TARGETS: Array<{ target: RoutingTarget; harness: Harness }> = [
  { target: "claude", harness: "claude-code" },
  { target: "codex", harness: "codex" },
  { target: "acp-omp", harness: "acp-omp" },
  { target: "acp-fx", harness: "acp-fx" },
  { target: "acp-nanocodex", harness: "acp-nanocodex" },
  { target: "pi", harness: "pi" },
];
const CLAUDE_ONLY =
  "Claude subscription logins serve Claude Code only. Other routes cannot use them.";
const JEV_NOT_LIVE =
  "It cannot run live yet: OpenRouter lists only typesafe/jev-router, which routes and runs the request, not a model that returns a choice.";
const FAMILY_LABELS: Record<ModelFamily, string> = {
  fable: "Fable 7 day",
  sonnet: "Sonnet 7 day",
  opus: "Opus 7 day",
  haiku: "Haiku 7 day",
  other: "Other 7 day",
};
const MODEL_FAMILIES: ModelFamily[] = [
  "fable",
  "sonnet",
  "opus",
  "haiku",
  "other",
];
const EMPTY_KEY_DRAFT: KeyDraft = {
  kind: "claude-key",
  label: "",
  baseUrl: "",
  apiKey: "",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpUrlError(value: string): string | null {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:"
      ? null
      : "Must be an HTTP or HTTPS URL.";
  } catch {
    return "Must be a valid URL.";
  }
}

function configDrafts(config: AccountPoolConfig): ConfigDrafts {
  return {
    anthropicUpstreamBaseUrl: config.anthropicUpstreamBaseUrl,
    codexUpstreamBaseUrl: config.codexUpstreamBaseUrl,
    switchThreshold: String(config.switchThreshold),
  };
}
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
function relative(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
function clock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
function windowShortLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "limit" : "limit 2";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}d`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}h`;
  return `${window.windowMinutes}m`;
}
function windowLongLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "Usage limit" : "Secondary limit";
  if (window.windowMinutes === 7 * 24 * 60) return "Weekly";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440} day`;
  if (window.windowMinutes % 60 === 0)
    return `${window.windowMinutes / 60} hour`;
  return `${window.windowMinutes} minute`;
}
function exhaustedResetAt(account: AccountSummary): number | null {
  return (
    account.fiveHourResetAt ??
    account.sevenDayResetAt ??
    account.limitWindows.find((window) => window.resetAt !== null)?.resetAt ??
    null
  );
}
function resetLabel(timestamp: number | null): string {
  if (timestamp === null) return "";
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 1_440)
    return `resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`}`;
  return `resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)}`;
}
function statusPresentation(account: AccountSummary): {
  label: string;
  dot: string;
} {
  if (account.status === "held")
    return {
      label: `Held${account.heldUntil === null ? "" : ` · retry at ${clock(account.heldUntil)}`}`,
      dot: "bg-warning",
    };
  if (account.status === "exhausted")
    return {
      label: `Exhausted${exhaustedResetAt(account) === null ? "" : ` · ${resetLabel(exhaustedResetAt(account))}`}`,
      dot: "bg-destructive",
    };
  if (account.status === "error")
    return { label: "Error", dot: "bg-destructive" };
  if (account.status === "disabled")
    return { label: "Disabled", dot: "bg-muted-foreground" };
  return { label: "Ready", dot: "bg-success" };
}
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
/** Plain kind of an upstream row: Claude Max, ChatGPT Pro, API key · Responses. */
function kindLabel(account: AccountSummary): string {
  const plan =
    account.subscriptionType === null ||
    account.subscriptionType === undefined
      ? ""
      : ` ${capitalize(account.subscriptionType)}`;
  switch (upstreamKind(account)) {
    case "claude-oauth":
      return `Claude${plan}`;
    case "chatgpt-oauth":
      return `ChatGPT${plan}`;
    case "claude-key":
      return "Anthropic API key";
    case "anthropic-compatible-key":
      return "API key · Messages";
    case "responses-compatible-key":
      return "API key · Responses";
  }
}
function quotaSummary(account: AccountSummary): string | null {
  const parts =
    account.provider === "codex"
      ? account.limitWindows.map(
          (window) =>
            `${windowShortLabel(window)} ${percent(window.utilization)}`,
        )
      : [
          account.fiveHourUtilization === null
            ? null
            : `5h ${percent(account.fiveHourUtilization)}`,
          account.sevenDayUtilization === null
            ? null
            : `7d ${percent(account.sevenDayUtilization)}`,
        ].filter((part) => part !== null);
  return account.kind === "api-key" || parts.length === 0
    ? null
    : parts.join(" · ");
}

function accountIdentity(account: AccountSummary): string {
  return `${account.provider}:${account.kind === "api-key" ? account.id
    : account.provider === "claude" ? (account.accountUuid ?? account.id)
      : (account.codexAccountId ?? account.id)}`;
}
function distinctAccounts(accounts: AccountSummary[]): AccountSummary[] {
  const byIdentity = new Map<string, AccountSummary>();
  for (const account of accounts) {
    const key = accountIdentity(account);
    const previous = byIdentity.get(key);
    if (previous === undefined || (account.enabled && !previous.enabled) ||
      (account.enabled === previous.enabled && (account.observedAt ?? 0) > (previous.observedAt ?? 0)))
      byIdentity.set(key, account);
  }
  return [...byIdentity.values()];
}

function footerWindows(account: AccountSummary): Array<{ label: string; utilization: number; resetAt: number | null }> {
  if (account.kind === "api-key") return [];
  if (account.provider === "codex")
    return account.limitWindows
      .filter((window) => window.utilization !== null &&
        !(window.slot === "secondary" && window.windowMinutes === null && window.resetAt === 0))
      .map((window) => ({
        label: windowShortLabel(window),
        utilization: window.utilization!,
        resetAt: window.resetAt,
      }));
  return [
    { label: "5h", utilization: account.fiveHourUtilization, resetAt: account.fiveHourResetAt },
    { label: "7d", utilization: account.sevenDayUtilization, resetAt: account.sevenDayResetAt },
    ...MODEL_FAMILIES.map((family) => ({
      label: `7d · ${capitalize(family)}`,
      utilization: account.familyWeekly[family]?.utilization ?? null,
      resetAt: account.familyWeekly[family]?.resetAt ?? null,
    })),
  ].filter((window): window is { label: string; utilization: number; resetAt: number | null } => window.utilization !== null);
}

function FooterUsageBar({ label, utilization, resetAt, account }: {
  label: string; utilization: number; resetAt: number | null; account: string;
}) {
  const used = Math.min(100, Math.max(0, Math.round(utilization * 100)));
  const remaining = resetAt === null || resetAt <= Date.now() ? "" : (() => {
    const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000));
    if (minutes >= 1_440) return `${Math.ceil(minutes / 1_440)}d`;
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  })();
  return (
    <div className="flex items-center gap-2 text-2xs tabular-nums">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <div role="progressbar" aria-label={`${account} ${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", used >= 98 ? "bg-destructive" : "bg-warning")}
          style={{ width: `${used}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right font-medium text-foreground">{used}%</span>
      <span className="w-12 shrink-0 text-right text-muted-foreground" title={resetAt === null || resetAt <= 0 ? undefined : `Resets ${new Date(resetAt).toLocaleString()}`}>
        {remaining}
      </span>
    </div>
  );
}

function GatewayAccountPanel({ account }: { account: AccountSummary }) {
  const windows = footerWindows(account);
  return (
    <div className="px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {account.kind === "api-key" ? <Icon name="Lock" className="size-4 shrink-0 text-muted-foreground" /> :
          account.provider === "claude" ? <GatewayClaudeIcon className="size-4 shrink-0" /> :
            <GatewayChatGPTIcon className="size-4 shrink-0" />}
        <span className="min-w-0 truncate text-xs font-medium text-foreground" title={account.email ?? account.label}>{account.email ?? account.label}</span>
      </div>
      {windows.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">
        {account.kind === "api-key" ? "Provider limit unavailable" : "Usage unavailable"}
      </p> : <div className="mt-1.5 space-y-1">
        {windows.map((window) => <FooterUsageBar key={window.label} {...window} account={account.label} />)}
      </div>}
      {account.observedAt === null ? null : <div className="mt-1.5 text-right text-2xs text-muted-foreground">Updated {relative(account.observedAt)}</div>}
    </div>
  );
}

const FOOTER_USAGE_CACHE_KEY = "model-gateway.footer-usage.v2";
const FOOTER_USAGE_CACHE_MS = 5 * 60_000;
type FooterUsageSnapshot = { accounts: AccountSummary[]; fetchedAt: number };
function cachedFooterUsage(): FooterUsageSnapshot | null {
  try {
    const raw = sessionStorage.getItem(FOOTER_USAGE_CACHE_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !Array.isArray((value as FooterUsageSnapshot).accounts) ||
      typeof (value as FooterUsageSnapshot).fetchedAt !== "number") return null;
    return value as FooterUsageSnapshot;
  } catch { return null; }
}
function cacheFooterUsage(snapshot: FooterUsageSnapshot): void {
  try { sessionStorage.setItem(FOOTER_USAGE_CACHE_KEY, JSON.stringify(snapshot)); } catch { /* Storage may be unavailable. */ }
}

function GatewayUsageFooter({ dismiss }: { dismiss: () => void }) {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const [snapshot, setSnapshot] = useState<FooterUsageSnapshot | null>(cachedFooterUsage);
  const accounts = snapshot?.accounts ?? null;
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await rpc.call("account.list", null);
      const updated = { accounts: next, fetchedAt: Date.now() };
      cacheFooterUsage(updated);
      setSnapshot(updated);
      setError(null);
    } catch (cause) { setError(errorText(cause)); }
  }, [rpc]);
  useEffect(() => {
    if (Date.now() - (cachedFooterUsage()?.fetchedAt ?? 0) >= FOOTER_USAGE_CACHE_MS) void load();
  }, [load]);
  useRealtime(MODEL_GATEWAY_ACCOUNTS_CHANGED, () => { void load(); });
  async function refresh() {
    if (refreshing || accounts === null) return;
    setRefreshing(true);
    try {
      await Promise.all(accounts.filter((account) => account.kind === "oauth")
        .map((account) => rpc.call("account.refreshUsage", { accountId: account.id })));
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <section aria-label="Model Gateway usage" className="bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <h2 className="text-xs font-semibold">Gateway usage</h2>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={refreshing || accounts === null} aria-label="Refresh Gateway usage">
            <Icon name="RotateCcw" className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss} aria-label="Close Gateway usage">
            <Icon name="X" className="size-4" />
          </Button>
        </div>
      </div>
      {error === null ? null : <p role="alert" className="px-4 py-2 text-xs text-destructive-text">{error}</p>}
      {accounts === null ? <p className="px-4 py-5 text-xs text-muted-foreground">Loading accounts…</p> :
        accounts.length === 0 ? <p className="px-4 py-5 text-xs text-muted-foreground">No Gateway accounts connected.</p> :
        <div className="divide-y divide-border">
          {distinctAccounts(accounts).map((account) => <GatewayAccountPanel key={accountIdentity(account)} account={account} />)}
        </div>}
    </section>
  );
}
/** `claude-sonnet-5` → Sonnet, `claude-opus-*` → Opus; other ids stay as written. */
function modelName(model: string): string {
  const family = /^claude-([a-z]+)-/u.exec(model)?.[1];
  return family === undefined ? model : capitalize(family);
}
/** "Sonnet or Opus", "gpt-6-luna, gpt-6-sol or gpt-6-astra". */
function orList(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}
const MESSAGES_KINDS = new Set<string>([
  "claude-oauth",
  "claude-key",
  "anthropic-compatible-key",
]);
/**
 * Model rewrites on a harness's chain, one line per step that has any:
 * "On ChatGPT: Opus, Fable → gpt-6-astra · Sonnet → gpt-6-sol". Only steps
 * that change the protocol, or a compatible vendor with its own model names.
 */
function mappedModelLines(
  harness: Harness,
  entries: string[],
  labels: (entry: string) => string,
  modelMap: AccountPoolConfig["modelMap"],
): string[] {
  return entries.flatMap((entry) => {
    const kind = entry.slice(0, entry.indexOf(":"));
    if (
      MESSAGES_KINDS.has(kind) === (harness === "claude-code") &&
      !kind.endsWith("-compatible-key")
    )
      return [];
    const rows = { ...modelMap[kind], ...modelMap[entry] };
    const byTarget = new Map<string, string[]>();
    for (const [pattern, model] of Object.entries(rows))
      byTarget.set(model, [...(byTarget.get(model) ?? []), modelName(pattern)]);
    if (byTarget.size === 0) return [];
    return [
      `On ${labels(entry)}: ${[...byTarget]
        .map(([model, patterns]) => `${patterns.join(", ")} → ${model}`)
        .join(" · ")}`,
    ];
  });
}

function SettingsBadge({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground"
    >
      {children}
    </span>
  );
}

function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {description}
          </p>
        </div>
        {action === undefined ? null : (
          <div className="shrink-0 self-start">{action}</div>
        )}
      </div>
      <div className="border-t border-border">{children}</div>
    </section>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="pt-3 pb-1 text-2xs font-medium uppercase tracking-wide text-subtle-foreground/75">
      {children}
    </h3>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="py-2.5 text-sm text-subtle-foreground">{children}</p>;
}

const restrictDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
const dragModifiers: Modifier[] = [restrictDragToVerticalAxis];

function DragHandle({
  label,
  disabled,
  sortable,
}: {
  label: string;
  disabled: boolean;
  sortable: ReturnType<typeof useSortable>;
}) {
  return (
    <Button
      ref={sortable.setActivatorNodeRef}
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 touch-none text-muted-foreground enabled:cursor-grab enabled:active:cursor-grabbing"
      disabled={disabled}
      aria-label={label}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <Icon name="DragDropVertical" aria-hidden="true" />
    </Button>
  );
}

type AccountAction = "toggle" | "priority" | "refresh" | "remove";

/** One Upstreams row: an OAuth account or an API key. */
function UpstreamRow({
  account,
  pending,
  onAction,
  onOpen,
}: {
  account: AccountSummary;
  pending: boolean;
  onAction: (action: AccountAction) => void;
  onOpen: () => void;
}) {
  const status = statusPresentation(account);
  const quota = quotaSummary(account);
  return (
    <div
      className={cn(
        "group -mx-2 flex min-w-0 items-center gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-state-hover focus-within:bg-state-hover",
        !account.enabled && "opacity-55",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open ${account.label}`}
        onClick={onOpen}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">
              {account.label}
            </span>
            <SettingsBadge
              title={
                upstreamKind(account) === "claude-oauth" ? CLAUDE_ONLY : undefined
              }
            >
              {kindLabel(account)}
            </SettingsBadge>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", status.dot)} />
              {status.label}
            </span>
            {quota === null ? null : (
              <span className="tabular-nums">{quota}</span>
            )}
            {account.lastUsedAt === null ? null : (
              <span>used {relative(account.lastUsedAt)}</span>
            )}
          </div>
        </div>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 data-[state=open]:bg-state-active"
            aria-label={`${account.label} actions`}
          >
            <Icon name="MoreHorizontal" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={pending}
            onSelect={() => onAction("toggle")}
          >
            <Icon name={account.enabled ? "Circle" : "CircleCheck"} />
            {account.enabled ? "Disable" : "Enable"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending}
            onSelect={() => onAction("priority")}
          >
            <Icon name="ListView" />
            Set priority…
          </DropdownMenuItem>
          {account.kind === "oauth" ? (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("refresh")}
            >
              <Icon name="RotateCcw" />
              Refresh usage
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onSelect={() => onAction("remove")}
          >
            <Icon name="Trash2" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        aria-label={`Open ${account.label} details`}
        onClick={onOpen}
      >
        <ResourceRowDetailChevron />
      </button>
    </div>
  );
}

function ChainRow({
  title,
  option,
  pending,
  reorderDisabled,
  onRemove,
}: {
  title: string;
  option: ChainOption;
  pending: boolean;
  reorderDisabled: boolean;
  onRemove: (() => void) | null;
}) {
  const sortable = useSortable({
    id: option.entry,
    disabled: pending || reorderDisabled,
  });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "flex items-center gap-3 text-sm",
        sortable.isDragging &&
          "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      <DragHandle
        label={`Reorder ${option.label} in ${title}`}
        disabled={pending || reorderDisabled}
        sortable={sortable}
      />
      <div className="group -mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-state-hover focus-within:bg-state-hover">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm text-foreground">
              {option.label}
            </span>
            {option.blocked === null ? null : (
              <SettingsBadge>Blocked</SettingsBadge>
            )}
          </div>
          {option.blocked === null ? null : (
            <div className="truncate text-xs text-destructive-text">
              {option.blocked}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          disabled={pending || onRemove === null}
          aria-label={`Remove ${option.label} from ${title}`}
          onClick={onRemove ?? undefined}
        >
          <Icon name="X" className="size-4" />
        </Button>
      </div>
    </div>
  );
}

type AddChoice =
  | "claude-login"
  | "codex-login"
  | "claude-import"
  | "codex-import"
  | "api-key";

function AddUpstreamMenu({
  onChoose,
}: {
  onChoose: (choice: AddChoice) => void;
}) {
  const items: Array<{
    choice: AddChoice;
    icon: "UserRound" | "Download" | "Plus";
    title: string;
    hint: string;
  }> = [
    {
      choice: "claude-login",
      icon: "UserRound",
      title: "Sign in to Claude",
      hint: "Opens claude.ai, paste the code back",
    },
    {
      choice: "codex-login",
      icon: "UserRound",
      title: "Sign in to ChatGPT",
      hint: "Opens ChatGPT with a device code",
    },
    {
      choice: "claude-import",
      icon: "Download",
      title: "Import this machine's Claude login",
      hint: "Copies the server host's ~/.claude login",
    },
    {
      choice: "codex-import",
      icon: "Download",
      title: "Import this machine's ChatGPT login",
      hint: "Copies the server host's Codex login",
    },
    {
      choice: "api-key",
      icon: "Plus",
      title: "Add API key",
      hint: "Anthropic, Messages or Responses vendor",
    },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon name="Plus" className="size-3.5" />
          Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.choice}
            className="items-start py-2"
            onSelect={() => onChoose(item.choice)}
          >
            <Icon name={item.icon} className="mt-0.5" />
            <span>
              <span className="block">{item.title}</span>
              <span className="block text-xs text-muted-foreground">
                {item.hint}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1.5" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((value) => (
        <span
          key={value}
          className={cn(
            "h-1 flex-1 rounded-full",
            value <= step ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}
function QuotaDetail({
  label,
  quota,
  threshold,
}: {
  label: string;
  quota: FamilyQuota | null;
  threshold: number;
}) {
  const utilization = quota?.utilization ?? null;
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              utilization !== null && utilization >= 1
                ? "bg-destructive"
                : utilization !== null && utilization >= threshold - 0.1
                  ? "bg-warning"
                  : "bg-primary",
            )}
            style={{
              width: `${Math.min(100, Math.max(0, (utilization ?? 0) * 100))}%`,
            }}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {percent(utilization)}
          {quota?.resetAt === null || quota === null
            ? ""
            : ` · ${resetLabel(quota.resetAt)}`}{" "}
          · will be skipped at {Math.round(threshold * 100)}%
        </div>
      </div>
    </div>
  );
}
function DrawerFrame({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-5 pb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          onClick={onClose}
        >
          <Icon name="X" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {children}
      </div>
      {footer ? (
        <div className="flex items-center gap-2 border-t border-border px-5 py-4">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function ConfigFieldRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: ReactNode;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="w-80 max-w-[50%] shrink-0">
        {children}
        {error === null ? null : (
          <p className="mt-1 text-xs text-destructive-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** One Routes row: switch, harness, its chain in plain names, the model rewrites and Jev. */
function RouteRow({
  harness,
  enabled,
  disabled,
  chain,
  mapped,
  autoText,
  hasSetup,
  onToggle,
  onSetup,
  onEdit,
}: {
  harness: Harness;
  enabled: boolean;
  disabled: boolean;
  chain: ChainOption[];
  mapped: string[];
  autoText: string | null;
  hasSetup: boolean;
  onToggle: (enabled: boolean) => void;
  onSetup: () => void;
  onEdit: () => void;
}) {
  const title = HARNESS_TITLES[harness];
  return (
    <div className="flex items-start gap-3 py-2.5">
      <Switch
        className="mt-0.5"
        checked={enabled}
        disabled={disabled}
        aria-label={`Route ${title} threads`}
        onCheckedChange={onToggle}
      />
      <div className="grid min-w-0 flex-1 grid-cols-[6.5rem_1fr] gap-x-3 gap-y-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span
          className={cn(
            "min-w-0 text-sm",
            enabled ? "text-foreground" : "text-subtle-foreground",
          )}
        >
          {chain.length === 0
            ? "—"
            : chain.map((option, index) => (
                <span key={option.entry}>
                  {index === 0 ? "" : " → "}
                  <span
                    className={cn(
                      option.blocked !== null &&
                        "text-destructive-text line-through",
                    )}
                    title={option.blocked ?? undefined}
                  >
                    {option.label}
                  </span>
                </span>
              ))}
        </span>
        {[...mapped, ...(autoText === null ? [] : [autoText])].map((line) => (
          <p
            key={line}
            className="col-start-2 text-xs leading-snug text-subtle-foreground/75"
          >
            {line}
          </p>
        ))}
      </div>
      {hasSetup ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${title} setup`}
          onClick={onSetup}
        >
          Setup
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        aria-label={`Edit ${title} route`}
        onClick={onEdit}
      >
        Edit
      </Button>
    </div>
  );
}

function ModelGatewaySettings() {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [config, setConfig] = useState<AccountPoolConfig | null>(null);
  const [routing, setRouting] = useState<RoutingState | null>(null);
  const [chainOptions, setChainOptions] = useState<Record<
    Harness,
    ChainOption[]
  > | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [drafts, setDrafts] = useState<ConfigDrafts>({
    anthropicUpstreamBaseUrl: "",
    codexUpstreamBaseUrl: "",
    switchThreshold: "",
  });
  const [configErrors, setConfigErrors] = useState<ConfigErrors>({
    anthropicUpstreamBaseUrl: null,
    codexUpstreamBaseUrl: null,
    switchThreshold: null,
  });
  const [jevModel, setJevModel] = useState("");
  const [mapDraft, setMapDraft] = useState({ key: "", pattern: "", model: "" });
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [optimisticChain, setOptimisticChain] = useState<{
    harness: Harness;
    entries: string[];
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [loginStep, setLoginStep] = useState<LoginStep | null>(null);
  const [codexStep, setCodexStep] = useState<CodexLoginStep | null>(null);
  const [loginDone, setLoginDone] = useState<string | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [keyDraft, setKeyDraft] = useState<KeyDraft>(EMPTY_KEY_DRAFT);
  const [priority, setPriority] = useState("100");
  const [countdown, setCountdown] = useState(0);
  const mounted = useRef(true);
  const threshold = config?.switchThreshold ?? 0.98;
  const applyConfig = useCallback((next: AccountPoolConfig) => {
    setConfig(next);
    setDrafts(configDrafts(next));
    setJevModel(next.auto.model);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextRouting, nextOptions, nextLive] =
        await Promise.all([
          rpc.call("status.get", null),
          rpc.call("routing.get", null),
          rpc.call("chain.options", null),
          rpc.call("live.get", null),
        ]);
      if (!mounted.current) return;
      setStatus(nextStatus);
      setRouting(nextRouting);
      setChainOptions(nextOptions);
      setLive(nextLive);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [rpc]);
  // Config changes move the chain labels and the Jev ladders (they follow the model map).
  const refreshConfig = useCallback(async () => {
    try {
      const [next, nextOptions, nextRouting] = await Promise.all([
        rpc.call("config.get", null),
        rpc.call("chain.options", null),
        rpc.call("routing.get", null),
      ]);
      if (!mounted.current) return;
      applyConfig(next);
      setChainOptions(nextOptions);
      setRouting(nextRouting);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [applyConfig, rpc]);
  const refreshLive = useCallback(async () => {
    try {
      const next = await rpc.call("live.get", null);
      if (mounted.current) setLive(next);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [rpc]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshConfig();
    return () => {
      mounted.current = false;
    };
  }, [refresh, refreshConfig]);
  useRealtime(MODEL_GATEWAY_ACCOUNTS_CHANGED, () => {
    void refresh();
  });
  useRealtime(MODEL_GATEWAY_CONFIG_CHANGED, () => {
    void refreshConfig();
  });
  useRealtime(MODEL_GATEWAY_ROUTE_CHANGED, () => {
    void refreshLive();
  });
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    const update = () =>
      setCountdown(
        Math.max(0, Math.ceil((codexStep.expiresAt - Date.now()) / 1_000)),
      );
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [codexStep, loginDone]);
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await rpc.call("codexLogin.poll", {
          sessionId: codexStep.sessionId,
        });
        if (cancelled) return;
        if (result.status === "complete") {
          setLoginDone(result.account.label);
          setCodexStep(null);
          await refresh();
        } else if (result.status === "error") {
          setCodexStep(null);
          setError(result.message);
        } else timer = setTimeout(poll, codexStep.intervalMs);
      } catch (pollError) {
        if (!cancelled) setError(errorText(pollError));
      }
    };
    timer = setTimeout(poll, codexStep.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [codexStep, loginDone, refresh, rpc]);
  const accounts = [...(status?.accounts ?? [])].sort(
    (left, right) =>
      UPSTREAM_KINDS.indexOf(upstreamKind(left)) -
      UPSTREAM_KINDS.indexOf(upstreamKind(right)),
  );
  const keys = accounts.filter((account) => account.kind === "api-key");
  const jevKeys = keys.filter(
    (account) => upstreamKind(account) === "responses-compatible-key",
  );
  const selectedAccount =
    drawer?.kind === "account" ||
    drawer?.kind === "priority" ||
    drawer?.kind === "remove"
      ? (accounts.find((account) => account.id === drawer.accountId) ?? null)
      : null;
  const keyKind =
    KEY_KINDS.find((option) => option.kind === keyDraft.kind) ?? KEY_KINDS[0]!;
  const keyDraftError =
    keyDraft.label.length > 0 && !KEY_LABEL.test(keyDraft.label)
      ? "Labels use letters, digits, '.', '_' and '-' only."
      : keyKind.needsBaseUrl && keyDraft.baseUrl.trim().length > 0
        ? httpUrlError(keyDraft.baseUrl.trim())
        : null;
  const modelMapKeys = [
    ...UPSTREAM_KINDS,
    ...keys.flatMap((account) =>
      KEY_LABEL.test(account.label)
        ? [`${upstreamKind(account)}:${account.label}`]
        : [],
    ),
  ];
  const fallbackThreads =
    live?.threads.filter((route) => route.entryIndex > 0) ?? [];
  const autoThreads =
    live?.threads.filter((route) => route.autoModel !== null) ?? [];
  const latestAuto = [...autoThreads].sort(
    (left, right) => right.usedAt - left.usedAt,
  )[0];
  const liveParts = [
    fallbackThreads.length > 0 &&
      `${fallbackThreads.length} ${fallbackThreads.length === 1 ? "thread" : "threads"} on a fallback`,
    latestAuto !== undefined &&
      `${autoThreads.length} on a Jev pick, latest ${autoPick(latestAuto.autoModel, latestAuto.autoReason)}`,
    (live?.holds.length ?? 0) > 0 &&
      `${live?.holds.length} ${live?.holds.length === 1 ? "account" : "accounts"} held`,
  ].filter((part): part is string => typeof part === "string");
  async function run(key: string, action: () => Promise<void>): Promise<void> {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setPending(null);
    }
  }
  /** Config edits: apply the returned config now, the realtime event refreshes the rest. */
  function saveConfig(
    key: string,
    save: () => Promise<AccountPoolConfig>,
  ): Promise<void> {
    return run(key, async () => {
      applyConfig(await save());
      setChainOptions(await rpc.call("chain.options", null));
    });
  }
  function updateConfigDraft(field: ConfigField, value: string): void {
    setDrafts((current) => ({ ...current, [field]: value }));
    setConfigErrors((current) => ({ ...current, [field]: null }));
  }
  async function saveConfigField(field: ConfigField): Promise<void> {
    if (config === null || pending !== null) return;
    let update: AccountPoolConfigSetInput;
    if (field === "switchThreshold") {
      const raw = drafts.switchThreshold.trim();
      const value = Number(raw);
      if (
        raw.length === 0 ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > 1
      ) {
        setConfigErrors((current) => ({
          ...current,
          switchThreshold: "Must be greater than 0 and at most 1.",
        }));
        return;
      }
      if (value === config.switchThreshold) return;
      update = { switchThreshold: value };
    } else {
      const value = drafts[field].trim();
      const validationError = httpUrlError(value);
      if (validationError !== null) {
        setConfigErrors((current) => ({
          ...current,
          [field]: validationError,
        }));
        return;
      }
      if (value === config[field]) return;
      update =
        field === "anthropicUpstreamBaseUrl"
          ? { anthropicUpstreamBaseUrl: value }
          : { codexUpstreamBaseUrl: value };
    }
    setPending(`config-${field}`);
    setConfigErrors((current) => ({ ...current, [field]: null }));
    try {
      applyConfig(await rpc.call("config.set", update));
    } catch (saveError) {
      setConfigErrors((current) => ({
        ...current,
        [field]: errorText(saveError),
      }));
    } finally {
      setPending(null);
    }
  }
  async function startClaude(): Promise<void> {
    setDrawer({ kind: "claude-login" });
    setLoginDone(null);
    await run("claude-login", async () => {
      const started = await rpc.call("login.start", null);
      setLoginStep(started);
      setPastedCode("");
    });
  }
  async function startCodex(): Promise<void> {
    setDrawer({ kind: "codex-login" });
    setLoginDone(null);
    await run("codex-login", async () => {
      setCodexStep(await rpc.call("codexLogin.start", null));
    });
  }
  async function chooseAdd(choice: AddChoice): Promise<void> {
    if (choice === "claude-login") return startClaude();
    if (choice === "codex-login") return startCodex();
    if (choice === "api-key") {
      setDrawer({ kind: "api-key" });
      return;
    }
    const provider: PoolProvider =
      choice === "claude-import" ? "claude" : "codex";
    await run(`import-${provider}`, async () => {
      await rpc.call("account.add", {
        provider,
        source: { kind: "import" },
        label: null,
        priority: 100,
      });
    });
  }
  async function accountAction(
    account: AccountSummary,
    action: AccountAction,
  ): Promise<void> {
    if (action === "priority") {
      setPriority(String(account.priority));
      setDrawer({ kind: "priority", accountId: account.id });
      return;
    }
    if (action === "remove") {
      setDrawer({ kind: "remove", accountId: account.id });
      return;
    }
    await run(`${action}-${account.id}`, async () => {
      if (action === "toggle")
        await rpc.call(account.enabled ? "account.disable" : "account.enable", {
          id: account.id,
        });
      if (action === "refresh")
        await rpc.call("account.refreshUsage", { accountId: account.id });
    });
  }
  async function saveChain(harness: Harness, entries: string[]): Promise<void> {
    setOptimisticChain({ harness, entries });
    try {
      await saveConfig(`chain-${harness}`, () =>
        rpc.call("chain.set", { harness, entries }),
      );
    } finally {
      setOptimisticChain(null);
    }
  }
  async function reorderChain(
    harness: Harness,
    entries: string[],
    event: DragEndEvent,
  ): Promise<void> {
    if (pending !== null || event.over === null) return;
    const from = entries.indexOf(String(event.active.id));
    const to = entries.indexOf(String(event.over.id));
    if (from < 0 || to < 0 || from === to) return;
    await saveChain(harness, arrayMove(entries, from, to));
  }
  function chainEntries(harness: Harness): string[] {
    return optimisticChain?.harness === harness
      ? optimisticChain.entries
      : (config?.chains[harness] ?? []);
  }
  function chainOption(harness: Harness, entry: string): ChainOption {
    return (
      chainOptions?.[harness].find((candidate) => candidate.entry === entry) ?? {
        entry,
        label: entry,
        blocked: null,
      }
    );
  }
  function mappedLines(harness: Harness): string[] {
    return config === null
      ? []
      : mappedModelLines(
          harness,
          chainEntries(harness),
          (entry) => chainOption(harness, entry).label,
          config.modelMap,
        );
  }
  /** Plain words for a harness's Jev auto mode, or null when it is off. */
  function autoText(harness: Harness): string | null {
    if (config === null || !config.auto.harnesses.includes(harness))
      return null;
    const ladder = (routing?.ladders[harness] ?? []).map(modelName);
    return `Auto (Jev): Jev picks ${ladder.length === 0 ? "the model" : orList(ladder)} on each new user turn.`;
  }
  /** Why the Jev switch cannot turn on, or null. The key comes from Advanced, or the only key there is. */
  function autoBlock(): string | null {
    if (jevKeys.length === 0)
      return "Add a responses-compatible API key (for example OpenRouter) first. Jev runs on it.";
    if (config?.auto.key === null && jevKeys.length > 1)
      return "Choose the Jev key under Advanced first.";
    return null;
  }
  function closeDrawer(): void {
    if (drawer?.kind === "codex-login" && codexStep !== null)
      void rpc.call("codexLogin.cancel", { sessionId: codexStep.sessionId });
    setDrawer(null);
    setLoginStep(null);
    setCodexStep(null);
    setLoginDone(null);
    setKeyDraft(EMPTY_KEY_DRAFT);
    setError(null);
  }
  const hubHosts =
    status?.hosts.map((host) => host.hostName ?? host.hostId).join(", ") ||
    "no machines";
  const routeHarness = drawer?.kind === "route" ? drawer.harness : null;
  return (
    <div className="w-full space-y-6">
      <div className="space-y-1.5">
        <p className="text-xs text-subtle-foreground/75">
          Hub {status?.accepting ? "accepting" : "not accepting"} ·{" "}
          {status?.inFlight ?? 0} in flight · used by {hubHosts}
        </p>
        {liveParts.length === 0 ? null : (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-md border border-warning/40 px-3 py-1.5 text-xs text-warning-text"
          >
            <span className="min-w-0 truncate">{liveParts.join(" · ")}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 shrink-0"
              onClick={() => setDrawer({ kind: "live" })}
            >
              Show
            </Button>
          </div>
        )}
      </div>
      {error === null ? null : (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-surface-destructive px-3 py-2 text-sm text-destructive-text"
        >
          {error}
        </div>
      )}
      <SettingsSection
        title="Upstreams"
        description="Accounts and API keys the gateway can send model traffic to. A key is write-only: the gateway never shows it again."
        action={<AddUpstreamMenu onChoose={(choice) => void chooseAdd(choice)} />}
      >
        {status === null ? (
          <p className="py-2.5 text-sm text-muted-foreground">Loading…</p>
        ) : accounts.length === 0 ? (
          <EmptyRow>
            No upstreams yet. Threads use their machine&apos;s own login until
            you add one.
          </EmptyRow>
        ) : (
          <div className="divide-y divide-border">
            {accounts.map((account) => (
              <UpstreamRow
                key={account.id}
                account={account}
                pending={pending !== null}
                onAction={(action) => void accountAction(account, action)}
                onOpen={() =>
                  setDrawer({ kind: "account", accountId: account.id })
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>
      <SettingsSection
        title="Routes"
        description="Which harnesses use the gateway, and the order of upstreams each one tries. Off means the harness uses its own login."
      >
        {routing?.blockedBy === null || routing === null ? null : (
          <div
            role="status"
            className="mt-3 rounded-md border border-warning/40 px-3 py-2 text-sm text-warning-text"
          >
            {routing.blockedBy}
          </div>
        )}
        <div className="divide-y divide-border">
          {ROUTING_TARGETS.map(({ target, harness }) => (
            <RouteRow
              key={target}
              harness={harness}
              enabled={routing?.enabled[target] ?? false}
              disabled={routing === null || pending !== null}
              chain={chainEntries(harness).map((entry) =>
                chainOption(harness, entry),
              )}
              mapped={mappedLines(harness)}
              autoText={autoText(harness)}
              hasSetup={target !== "claude" && target !== "codex"}
              onToggle={(enabled) =>
                void run(`routing-${target}`, async () => {
                  await rpc.call("routing.set", { provider: target, enabled });
                })
              }
              onSetup={() =>
                setDrawer({ kind: "setup", target: target as SetupTarget })
              }
              onEdit={() => setDrawer({ kind: "route", harness })}
            />
          ))}
        </div>
      </SettingsSection>
      <Collapsible className="rounded-lg border border-border px-4">
        <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-sm font-medium text-foreground">
          <Icon
            name="ChevronRight"
            className="size-4 transition-transform [[data-state=open]>&]:rotate-90"
          />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border pb-2">
            <SubHeading>Model map</SubHeading>
            <p className="pb-1 text-xs leading-snug text-muted-foreground">
              Rewrites the requested model for an upstream kind. Patterns use *
              as a wildcard. A &lt;kind&gt;:&lt;label&gt; key wins over its
              kind.
            </p>
            {config === null ? null : (
              <>
                {Object.keys(config.modelMap).length === 0 ? (
                  <EmptyRow>No model rewrites.</EmptyRow>
                ) : (
                  <div className="divide-y divide-border">
                    {Object.entries(config.modelMap).flatMap(([key, rows]) =>
                      Object.entries(rows).map(([pattern, model]) => (
                        <div key={`${key} ${pattern}`} className="flex min-w-0">
                          <div className="group -mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-state-hover">
                            <SettingsBadge>{key}</SettingsBadge>
                            <span className="truncate font-mono text-xs text-foreground">
                              {pattern}
                            </span>
                            <Icon
                              name="ArrowRight"
                              className="size-3.5 shrink-0 text-subtle-foreground"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                              {model}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0"
                              disabled={pending !== null}
                              aria-label={`Remove ${key} ${pattern}`}
                              onClick={() =>
                                void saveConfig(`map-${key}-${pattern}`, () =>
                                  rpc.call("modelMap.set", {
                                    key,
                                    pattern,
                                    model: null,
                                  }),
                                )
                              }
                            >
                              <Icon name="X" className="size-4" />
                            </Button>
                          </div>
                        </div>
                      )),
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 border-t border-border py-2.5">
                  <Select
                    value={mapDraft.key}
                    onValueChange={(key) =>
                      setMapDraft((current) => ({ ...current, key }))
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-56"
                      aria-label="Model map upstream"
                    >
                      <SelectValue placeholder="Upstream kind or key" />
                    </SelectTrigger>
                    <SelectContent>
                      {modelMapKeys.map((key) => (
                        <SelectItem key={key} value={key}>
                          {key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className="h-8 w-40"
                    aria-label="Model pattern"
                    placeholder="claude-opus-*"
                    value={mapDraft.pattern}
                    onChange={(event) =>
                      setMapDraft((current) => ({
                        ...current,
                        pattern: event.target.value,
                      }))
                    }
                  />
                  <Input
                    className="h-8 w-40"
                    aria-label="Upstream model"
                    placeholder="gpt-6-astra"
                    value={mapDraft.model}
                    onChange={(event) =>
                      setMapDraft((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      pending !== null ||
                      mapDraft.key === "" ||
                      mapDraft.pattern.trim() === "" ||
                      mapDraft.model.trim() === ""
                    }
                    onClick={() =>
                      void saveConfig("map-add", async () => {
                        const next = await rpc.call("modelMap.set", {
                          key: mapDraft.key,
                          pattern: mapDraft.pattern.trim(),
                          model: mapDraft.model.trim(),
                        });
                        setMapDraft({
                          key: mapDraft.key,
                          pattern: "",
                          model: "",
                        });
                        return next;
                      })
                    }
                  >
                    Add
                  </Button>
                </div>
              </>
            )}
            <SubHeading>Jev auto mode</SubHeading>
            <p className="pb-1 text-xs leading-snug text-muted-foreground">
              Turn it on per route with Edit. {JEV_NOT_LIVE}
            </p>
            {config === null ? null : (
              <div className="divide-y divide-border">
                <ConfigFieldRow
                  label="Jev key"
                  description="The responses-compatible key that holds the OpenRouter key."
                  error={null}
                >
                  <Select
                    value={config.auto.key ?? ""}
                    disabled={pending !== null || jevKeys.length === 0}
                    onValueChange={(key) =>
                      void saveConfig("auto-key", () =>
                        rpc.call("auto.set", { key }),
                      )
                    }
                  >
                    <SelectTrigger aria-label="Jev key">
                      <SelectValue
                        placeholder={
                          jevKeys.length === 0
                            ? "Add a responses-compatible key first"
                            : "Choose a key"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {jevKeys.map((account) => (
                        <SelectItem key={account.id} value={account.label}>
                          {account.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </ConfigFieldRow>
                <ConfigFieldRow
                  label="Jev model"
                  description="OpenRouter model id of Jev."
                  error={null}
                >
                  <Input
                    aria-label="Jev model"
                    disabled={pending !== null}
                    value={jevModel}
                    onChange={(event) => setJevModel(event.target.value)}
                    onBlur={() => {
                      const model = jevModel.trim();
                      if (model === "" || model === config.auto.model)
                        setJevModel(config.auto.model);
                      else
                        void saveConfig("auto-model", () =>
                          rpc.call("auto.set", { model }),
                        );
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </ConfigFieldRow>
              </div>
            )}
            <SubHeading>Upstream base URLs and limits</SubHeading>
            <div className="divide-y divide-border">
              <ConfigFieldRow
                label="Anthropic upstream base URL"
                description="QA override for Anthropic traffic."
                error={configErrors.anthropicUpstreamBaseUrl}
              >
                <Input
                  aria-label="Anthropic upstream base URL"
                  aria-invalid={
                    configErrors.anthropicUpstreamBaseUrl === null
                      ? undefined
                      : true
                  }
                  disabled={config === null || pending !== null}
                  value={drafts.anthropicUpstreamBaseUrl}
                  onChange={(event) =>
                    updateConfigDraft(
                      "anthropicUpstreamBaseUrl",
                      event.target.value,
                    )
                  }
                  onBlur={() =>
                    void saveConfigField("anthropicUpstreamBaseUrl")
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Codex upstream base URL"
                description="QA override for ChatGPT Codex traffic."
                error={configErrors.codexUpstreamBaseUrl}
              >
                <Input
                  aria-label="Codex upstream base URL"
                  aria-invalid={
                    configErrors.codexUpstreamBaseUrl === null
                      ? undefined
                      : true
                  }
                  disabled={config === null || pending !== null}
                  value={drafts.codexUpstreamBaseUrl}
                  onChange={(event) =>
                    updateConfigDraft(
                      "codexUpstreamBaseUrl",
                      event.target.value,
                    )
                  }
                  onBlur={() => void saveConfigField("codexUpstreamBaseUrl")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Quota switch threshold"
                description="Stop selecting an account at this quota fraction."
                error={configErrors.switchThreshold}
              >
                <Input
                  type="number"
                  min="0.01"
                  max="1"
                  step="0.01"
                  aria-label="Quota switch threshold"
                  aria-invalid={
                    configErrors.switchThreshold === null ? undefined : true
                  }
                  disabled={config === null || pending !== null}
                  value={drafts.switchThreshold}
                  onChange={(event) =>
                    updateConfigDraft("switchThreshold", event.target.value)
                  }
                  onBlur={() => void saveConfigField("switchThreshold")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <div className="flex items-start justify-between gap-4">
                <div className="py-2.5">
                  <div className="text-sm text-foreground">Machine tokens</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {hubHosts}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2 py-2.5">
                  {status?.hosts.map((host) => (
                    <Button
                      key={host.hostId}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void run(`rotate-${host.hostId}`, async () => {
                          await rpc.call("token.rotate", {
                            machine: host.hostId,
                          });
                        })
                      }
                    >
                      Rotate {host.hostName ?? host.hostId}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <ResponsiveDrawerShell
        open={drawer !== null}
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
        srLabel="Model Gateway details"
        contentClassName="mx-auto w-full max-w-2xl"
      >
        {routeHarness === null || config === null
          ? null
          : (() => {
              const title = HARNESS_TITLES[routeHarness];
              const entries = chainEntries(routeHarness);
              const addable = (chainOptions?.[routeHarness] ?? []).filter(
                (candidate) => !entries.includes(candidate.entry),
              );
              const autoOn = config.auto.harnesses.includes(routeHarness);
              const block = autoOn ? null : autoBlock();
              const ladder = (routing?.ladders[routeHarness] ?? []).map(
                modelName,
              );
              return (
                <DrawerFrame title={`${title} route`} onClose={closeDrawer}>
                  <p className="text-sm text-muted-foreground">
                    The gateway sends each {title} request to the first
                    upstream with room, and moves down the list when one runs
                    out. Drag to reorder.
                  </p>
                  {error === null ? null : (
                    <p className="text-sm text-destructive-text" role="alert">
                      {error}
                    </p>
                  )}
                  <div>
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      modifiers={dragModifiers}
                      onDragEnd={(event) =>
                        void reorderChain(routeHarness, entries, event)
                      }
                    >
                      <SortableContext
                        items={entries}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="divide-y divide-border border-y border-border">
                          {entries.map((entry) => (
                            <ChainRow
                              key={entry}
                              title={title}
                              option={chainOption(routeHarness, entry)}
                              pending={pending !== null}
                              reorderDisabled={entries.length < 2}
                              onRemove={
                                entries.length < 2
                                  ? null
                                  : () =>
                                      void saveChain(
                                        routeHarness,
                                        entries.filter(
                                          (item) => item !== entry,
                                        ),
                                      )
                              }
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                    <Select
                      value=""
                      disabled={pending !== null || addable.length === 0}
                      onValueChange={(entry) =>
                        void saveChain(routeHarness, [...entries, entry])
                      }
                    >
                      <SelectTrigger
                        className="mt-3 h-8 w-64"
                        aria-label={`Add to the ${title} route`}
                      >
                        <SelectValue placeholder="Add upstream…" />
                      </SelectTrigger>
                      <SelectContent>
                        {addable.map((candidate) => (
                          <SelectItem
                            key={candidate.entry}
                            value={candidate.entry}
                            disabled={candidate.blocked !== null}
                          >
                            <span className="block">{candidate.label}</span>
                            {candidate.blocked === null ? null : (
                              <span className="block text-xs text-muted-foreground">
                                Blocked: {candidate.blocked}
                              </span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {mappedLines(routeHarness).map((line) => (
                      <p
                        key={line}
                        className="mt-2 text-xs text-muted-foreground"
                      >
                        {line}
                      </p>
                    ))}
                  </div>
                  <div className="space-y-2 border-t border-border pt-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm text-foreground">
                          Auto (Jev)
                        </div>
                        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                          Jev picks{" "}
                          {ladder.length === 0 ? "the model" : orList(ladder)}{" "}
                          on each new user turn. Later turns keep the pick.
                        </p>
                      </div>
                      <Switch
                        checked={autoOn}
                        disabled={pending !== null || block !== null}
                        aria-label={`Auto (Jev) for ${title}`}
                        onCheckedChange={(on) =>
                          void saveConfig(`auto-${routeHarness}`, () =>
                            rpc.call("auto.set", {
                              harness: routeHarness,
                              off: !on,
                              ...(on && config.auto.key === null
                                ? { key: jevKeys[0]?.label }
                                : {}),
                            }),
                          )
                        }
                      />
                    </div>
                    {block === null ? null : (
                      <p className="text-xs text-warning-text">{block}</p>
                    )}
                    <p className="text-xs leading-snug text-muted-foreground">
                      {JEV_NOT_LIVE}
                    </p>
                  </div>
                </DrawerFrame>
              );
            })()}
        {drawer?.kind === "setup" ? (
          <DrawerFrame
            title={`${HARNESS_TITLES[drawer.target]} setup`}
            onClose={closeDrawer}
          >
            <p className="text-sm text-muted-foreground">
              One-time setup on each machine. The gateway shows it and never
              runs it.
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-surface-recessed px-3 py-2 font-mono text-xs text-foreground">
              {routing?.setup[drawer.target] ?? "Loading…"}
            </pre>
          </DrawerFrame>
        ) : null}
        {drawer?.kind === "live" ? (
          <DrawerFrame title="Live state" onClose={closeDrawer}>
            <div>
              <SubHeading>Threads on a fallback or a Jev pick</SubHeading>
              {live === null || live.threads.length === 0 ? (
                <EmptyRow>None.</EmptyRow>
              ) : (
                <div className="divide-y divide-border">
                  {live.threads.map((route) => (
                    <div
                      key={route.threadId}
                      className="flex min-w-0 items-center gap-2 py-2 text-sm"
                      title={
                        route.fallbackCause === null
                          ? undefined
                          : `${route.fallbackCause.upstreamLabel}: ${route.fallbackCause.category} (HTTP ${route.fallbackCause.status}) — ${route.fallbackCause.message}`
                      }
                    >
                      <span className="truncate font-mono text-xs text-foreground">
                        {route.threadId}
                      </span>
                      <SettingsBadge>
                        {HARNESS_TITLES[route.harness]}
                      </SettingsBadge>
                      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground/75">
                        {route.entryIndex > 0
                          ? `step ${route.entryIndex + 1} · `
                          : ""}
                        {upstreamName(route.upstreamKind, route.upstreamLabel)}
                        {route.autoModel === null
                          ? route.model === null
                            ? ""
                            : ` · ${route.model}`
                          : ` · ${autoPick(route.autoModel, route.autoReason)}`}
                      </span>
                      <span className="shrink-0 text-xs text-subtle-foreground/75">
                        {route.stickyUntil === null
                          ? `used ${relative(route.usedAt)}`
                          : `sticky until ${clock(route.stickyUntil)}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <SubHeading>Held accounts</SubHeading>
              {live === null || live.holds.length === 0 ? (
                <EmptyRow>None.</EmptyRow>
              ) : (
                <div className="divide-y divide-border">
                  {live.holds.map((hold) => (
                    <div
                      key={hold.accountId}
                      className="flex min-w-0 items-center gap-2 py-2 text-sm"
                    >
                      <span className="truncate font-medium text-foreground">
                        {hold.label}
                      </span>
                      <SettingsBadge>
                        {upstreamName(hold.upstreamKind, hold.label)}
                      </SettingsBadge>
                      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground/75">
                        held until {clock(hold.until)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending !== null}
                        aria-label={`Clear the hold on ${hold.label}`}
                        onClick={() =>
                          void run(`hold-${hold.accountId}`, async () => {
                            await rpc.call("hold.clear", {
                              accountId: hold.accountId,
                            });
                          })
                        }
                      >
                        Clear
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DrawerFrame>
        ) : null}
        {drawer?.kind === "account" && selectedAccount !== null ? (
          <AccountDrawer
            account={selectedAccount}
            threshold={threshold}
            close={closeDrawer}
            act={(action) => void accountAction(selectedAccount, action)}
          />
        ) : null}
        {drawer?.kind === "priority" && selectedAccount !== null ? (
          <DrawerFrame
            title="Set priority"
            onClose={closeDrawer}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDrawer}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    !Number.isInteger(Number(priority)) || pending !== null
                  }
                  onClick={() =>
                    void run(`priority-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setPriority", {
                        accountId: selectedAccount.id,
                        priority: Number(priority),
                      });
                      setDrawer(null);
                    })
                  }
                >
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Lower numbers come first within a route step. Ties follow the
              order accounts were added. Existing conversations stay pinned.
            </p>
            <Input
              type="number"
              aria-label="Account priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </DrawerFrame>
        ) : null}
        {drawer?.kind === "api-key" ? (
          <DrawerFrame
            title="Add an API key"
            onClose={closeDrawer}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDrawer}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    pending !== null ||
                    keyDraftError !== null ||
                    keyDraft.label.length === 0 ||
                    keyDraft.apiKey.trim().length === 0 ||
                    (keyKind.needsBaseUrl && keyDraft.baseUrl.trim() === "")
                  }
                  onClick={() =>
                    void run("api-key", async () => {
                      await rpc.call("key.add", {
                        kind: keyDraft.kind,
                        label: keyDraft.label,
                        ...(keyKind.needsBaseUrl
                          ? { baseUrl: keyDraft.baseUrl.trim() }
                          : {}),
                        apiKey: keyDraft.apiKey.trim(),
                        priority: 100,
                      });
                      setKeyDraft(EMPTY_KEY_DRAFT);
                      setDrawer(null);
                    })
                  }
                >
                  Add API key
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Stored in the gateway&apos;s protected secret directory. The
              gateway never shows the key again. Add it to a route to use it.
            </p>
            {error === null ? null : (
              <p className="text-sm text-destructive-text" role="alert">
                {error}
              </p>
            )}
            <div className="space-y-3">
              <Select
                value={keyDraft.kind}
                onValueChange={(kind) =>
                  setKeyDraft((current) => ({
                    ...current,
                    kind: kind as KeyKind,
                  }))
                }
              >
                <SelectTrigger aria-label="Key kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KEY_KINDS.map((option) => (
                    <SelectItem key={option.kind} value={option.kind}>
                      {option.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {keyKind.description}
              </p>
              <Input
                aria-label="Key label"
                placeholder="openrouter"
                value={keyDraft.label}
                onChange={(event) =>
                  setKeyDraft((current) => ({
                    ...current,
                    label: event.target.value.trim(),
                  }))
                }
              />
              {keyKind.needsBaseUrl ? (
                <Input
                  aria-label="Key base URL"
                  placeholder="https://openrouter.ai/api/v1"
                  value={keyDraft.baseUrl}
                  onChange={(event) =>
                    setKeyDraft((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                />
              ) : null}
              <Input
                type="password"
                autoComplete="off"
                aria-label="API key"
                placeholder="Paste the key"
                value={keyDraft.apiKey}
                onChange={(event) =>
                  setKeyDraft((current) => ({
                    ...current,
                    apiKey: event.target.value,
                  }))
                }
              />
              {keyDraftError === null ? null : (
                <p className="text-xs text-destructive-text" role="alert">
                  {keyDraftError}
                </p>
              )}
            </div>
          </DrawerFrame>
        ) : null}
        {drawer?.kind === "remove" && selectedAccount !== null ? (
          <DrawerFrame
            title={`Remove ${selectedAccount.label}?`}
            onClose={closeDrawer}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDrawer}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`remove-${selectedAccount.id}`, async () => {
                      await rpc.call("account.remove", {
                        id: selectedAccount.id,
                      });
                      setDrawer(null);
                    })
                  }
                >
                  Remove
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              This deletes the account&apos;s secret file. Threads move to the
              next chain entry, or to their machine login when the chain has
              nothing left.
            </p>
          </DrawerFrame>
        ) : null}
        {drawer?.kind === "claude-login" ? (
          <LoginDrawer
            provider="claude"
            loginStep={loginStep}
            codexStep={null}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode={pastedCode}
            countdown={0}
            error={error}
            close={closeDrawer}
            openUrl={navigate.openUrl}
            setPastedCode={setPastedCode}
            complete={() =>
              void run("complete-claude", async () => {
                if (loginStep === null) return;
                const added = await rpc.call("login.complete", {
                  sessionId: loginStep.sessionId,
                  pasted: pastedCode,
                });
                setLoginDone(added.label);
                setLoginStep(null);
              })
            }
            addAnother={() => void startClaude()}
            retry={() => void startClaude()}
          />
        ) : null}
        {drawer?.kind === "codex-login" ? (
          <LoginDrawer
            provider="codex"
            loginStep={null}
            codexStep={codexStep}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode=""
            countdown={countdown}
            error={error}
            close={closeDrawer}
            openUrl={navigate.openUrl}
            setPastedCode={() => {}}
            complete={() => {}}
            addAnother={() => void startCodex()}
            retry={() => void startCodex()}
          />
        ) : null}
      </ResponsiveDrawerShell>
    </div>
  );
}

function AccountDrawer({
  account,
  threshold,
  close,
  act,
}: {
  account: AccountSummary;
  threshold: number;
  close: () => void;
  act: (action: "toggle" | "refresh" | "remove") => void;
}) {
  const shared = (
    utilization: number | null,
    resetAt: number | null,
    status: string | null,
  ): FamilyQuota => ({
    utilization,
    resetAt,
    status,
    observedAt: account.observedAt ?? 0,
    source: "header",
  });
  const providerId =
    account.provider === "claude"
      ? account.accountUuid
      : account.codexAccountId;
  return (
    <DrawerFrame
      title={account.label}
      onClose={close}
      footer={
        <>
          <Button size="sm" variant="outline" onClick={() => act("toggle")}>
            {account.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("refresh")}>
            Refresh usage
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive-text"
            onClick={() => act("remove")}
          >
            Remove
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <SettingsBadge
          title={
            upstreamKind(account) === "claude-oauth" ? CLAUDE_ONLY : undefined
          }
        >
          {kindLabel(account)}
        </SettingsBadge>
        <SettingsBadge>{statusPresentation(account).label}</SettingsBadge>
      </div>
      <div className="space-y-4">
        {account.provider === "codex" ? (
          account.limitWindows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No usage limits observed yet.
            </div>
          ) : (
            account.limitWindows.map((window) => (
              <QuotaDetail
                key={window.slot}
                label={windowLongLabel(window)}
                quota={window}
                threshold={threshold}
              />
            ))
          )
        ) : (
          <>
            <QuotaDetail
              label="5 hour"
              quota={shared(
                account.fiveHourUtilization,
                account.fiveHourResetAt,
                account.fiveHourStatus,
              )}
              threshold={threshold}
            />
            <QuotaDetail
              label="7 day"
              quota={shared(
                account.sevenDayUtilization,
                account.sevenDayResetAt,
                account.sevenDayStatus,
              )}
              threshold={threshold}
            />
            {MODEL_FAMILIES.flatMap((family) =>
              account.familyWeekly[family] === null
                ? []
                : [
                    <QuotaDetail
                      key={family}
                      label={FAMILY_LABELS[family]}
                      quota={account.familyWeekly[family]}
                      threshold={threshold}
                    />,
                  ],
            )}
          </>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-sm">
        <dt className="text-muted-foreground">Kind</dt>
        <dd>
          {account.kind === "oauth"
            ? `OAuth · ${account.provider === "claude" ? "claude.ai" : "ChatGPT"}`
            : "API key"}
        </dd>
        <dt className="text-muted-foreground">Upstream</dt>
        <dd className="font-mono text-xs">{upstreamKind(account)}</dd>
        {account.baseUrl === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Base URL</dt>
            <dd className="truncate">{account.baseUrl}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Priority</dt>
        <dd>{account.priority}</dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>
          {account.lastUsedAt === null
            ? "Never"
            : `${relative(account.lastUsedAt)}${account.lastUsedHostName === null ? "" : ` · ${account.lastUsedHostName}`}`}
        </dd>
        <dt className="text-muted-foreground">Usage refreshed</dt>
        <dd>
          {account.observedAt === null ? "Never" : relative(account.observedAt)}
        </dd>
        {providerId === null || providerId === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Account id</dt>
            <dd className="font-mono text-xs">{`${providerId.slice(0, 4)}…${providerId.slice(-4)}`}</dd>
          </>
        )}
      </dl>
    </DrawerFrame>
  );
}

function LoginDrawer({
  provider,
  loginStep,
  codexStep,
  loginDone,
  pending,
  pastedCode,
  countdown,
  error,
  close,
  openUrl,
  setPastedCode,
  complete,
  addAnother,
  retry,
}: {
  provider: PoolProvider;
  loginStep: LoginStep | null;
  codexStep: CodexLoginStep | null;
  loginDone: string | null;
  pending: boolean;
  pastedCode: string;
  countdown: number;
  error: string | null;
  close: () => void;
  openUrl: (url: string) => boolean;
  setPastedCode: (value: string) => void;
  complete: () => void;
  addAnother: () => void;
  retry: () => void;
}) {
  const name = provider === "claude" ? "Claude" : "ChatGPT";
  const url =
    provider === "claude"
      ? loginStep?.authorizeUrl
      : codexStep?.verificationUri;
  return (
    <DrawerFrame
      title={`Sign in to ${name}`}
      onClose={close}
      footer={
        <>
          <span className="flex-1" />
          {loginDone === null ? (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              {provider === "claude" ? (
                <Button
                  disabled={
                    loginStep === null ||
                    pastedCode.trim().length === 0 ||
                    pending
                  }
                  onClick={complete}
                >
                  Complete
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={addAnother}>
                Add another
              </Button>
              <Button onClick={close}>Done</Button>
            </>
          )}
        </>
      }
    >
      <StepIndicator step={loginDone === null ? 2 : 3} />
      {loginDone !== null ? (
        <div>
          <h3 className="text-base font-semibold">Connected {loginDone}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Routes that use {provider === "claude" ? "Claude Max" : "ChatGPT"}{" "}
            now go through this account. Usage refreshes in the background.
          </p>
        </div>
      ) : url === undefined ? (
        provider === "codex" && error !== null ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive-text">{error}</p>
            <Button variant="outline" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Starting sign-in…</p>
        )
      ) : (
        <>
          <div>
            <h3 className="text-base font-semibold">Sign in to {name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {provider === "claude"
                ? "Sign in at claude.ai, then paste the code from the final page."
                : "Open the verification page, sign in to ChatGPT, and enter this code."}
            </p>
          </div>
          {codexStep === null ? null : (
            <div
              className="rounded-lg border border-border bg-surface-recessed px-5 py-5 text-center font-mono text-2xl font-semibold tracking-widest"
              aria-label="Codex user code"
            >
              {codexStep.userCode}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              readOnly
              value={url}
              aria-label={`${name} authorization URL`}
            />
            <Button
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(url)}
            >
              Copy
            </Button>
            <Button onClick={() => openUrl(url)}>Open</Button>
          </div>
          {provider === "claude" ? (
            <Input
              aria-label="Claude authorization code"
              placeholder="Paste code#state here"
              value={pastedCode}
              onChange={(event) => setPastedCode(event.target.value)}
            />
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Waiting for you to authorize… expires in{" "}
              {Math.floor(countdown / 60)}:
              {String(countdown % 60).padStart(2, "0")}
            </p>
          )}
        </>
      )}
    </DrawerFrame>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "gateway-usage",
    label: "Model Gateway usage",
    icon: "ChartColumn",
    component: GatewayUsageFooter,
  });
  app.slots.experimental_threadHeaderAction({
    id: "model-gateway-route",
    title: "Model Gateway route",
    component: RouteBadge,
  });
  app.slots.settingsSection({
    id: "gateway",
    component: ModelGatewaySettings,
  });
  app.slots.experimental_providerIcon({
    providerKind: "agent",
    providerId: "acp-fx",
    icon: FxIcon,
  });
  app.slots.experimental_providerIcon({
    providerKind: "agent",
    providerId: "acp-nanocodex",
    icon: NanocodexIcon,
  });
});
