// Ported from the core Account Pooler (account-pool), MIT, Michael Yong 2026.
import type {
  Account,
  AccountQuota,
  AccountSecret,
  ModelFamily,
  PoolProvider,
  PoolStatus,
} from "./contracts.js";
import { createClaudeAdapter } from "./upstreams/claude-adapter.js";
import {
  createCodexAdapter,
  DEFAULT_CODEX_REFRESH_URL,
  DEFAULT_CODEX_USAGE_URL,
} from "./upstreams/codex-adapter.js";
import type { ProviderAdapter } from "./upstreams/provider-adapter.js";
import type { ImportedProviderAccount } from "./upstreams/provider-adapter.js";
import {
  CREDIT_BENCH_MS,
  createKeyAdapter,
  isCreditExhausted,
} from "./upstreams/apikey-adapter.js";
import { TransientOAuthRefreshError } from "./upstreams/provider-adapter.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./upstreams/credentials.js";
import {
  accountStatus,
  governingWeeklyResetAt,
  isQuotaExhausted,
  modelFamily,
  isSharedQuotaExhausted,
  retryAfterMilliseconds,
} from "./upstreams/quota.js";
import {
  EMPTY_QUOTA,
  type AccountBinding,
  type AccountStore,
  type HubTokenStore,
  type PoolAffinityStore,
  type QuotaStore,
  type ThreadRoute,
  type ThreadRouteStore,
} from "./upstreams/store.js";
import { askJev, JEV_TIMEOUT_MS, lastUserText, type JevPick } from "./jev.js";
import {
  apiKeyUpstreamMessage,
  autoLadder,
  contextExceededMessage,
  contextWindow,
  exhaustedUntil,
  expandChain,
  fitForChatGpt,
  gatewayModel,
  harnessSchema,
  hasClientTools,
  isLegalUpstream,
  isNewUserTurn,
  isRecord,
  mapModel,
  needsApiKeyUpstream,
  ompModels,
  onAutoLadder,
  orderEntries,
  replayIdentity,
  responseExhaustion,
  routePath,
  upstreamKind,
  type AutoSettings,
  type Chains,
  type Harness,
  type ModelMap,
  type ThreadIdentity,
  type UpstreamKind,
} from "./chain.js";
import {
  ANTHROPIC_REPLAY,
  CHATGPT_REPLAY,
  estimateTokens,
  fitReplay,
  messagesJsonToResponses,
  messagesStreamToResponses,
  messagesToResponses,
  responsesJsonToMessages,
  responsesStreamToMessages,
  responsesToMessages,
  TranslateError,
  wrapKeyOutput,
  wrapKeySse,
} from "./translate/index.js";

const ROUTE = "/api/v1/plugins/model-gateway/http";
/** FX cannot send a header, and core routes plugin paths exactly, so its hub token rides in the query. */
export const TOKEN_QUERY = "gateway_token";
const DEFAULT_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
// BB gives a service 5s to stop and loads the new plugin instance only after
// it has. New requests get 503 until then, so a long drain is a long outage.
const DEFAULT_DRAIN_TIMEOUT_MS = 4_000;
// Tells clients to retry once the reloaded instance is serving.
const STOPPING_RETRY_AFTER = { "retry-after": "5" };
const MAX_INLINE_HOLD_MS = 20_000;
const MAX_REFRESH_BACKOFF_MS = 60_000;
const MAX_REFRESH_BACKOFFS = 1_024;
const MAX_FAILURE_DETAIL_BYTES = 1_024;
const FAILURE_DISPOSAL_TIMEOUT_MS = 250;
const AFFINITY_IDLE_TTL_MS = 30 * 60 * 1_000;
const MAX_AFFINITY_BINDINGS = 4_096;
const THREAD_ROUTE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** A thread routed within this window counts for the `Gateway: on fallback` label. */
const RECENT_ROUTE_MS = 30 * 60 * 1_000;
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface HubSettings {
  anthropicUpstreamBaseUrl: string;
  codexUpstreamBaseUrl: string;
  switchThreshold: number;
  chains: Chains;
  modelMap: ModelMap;
  auto: AutoSettings;
}

/** One chain entry, narrowed to the accounts that may serve this request. */
export interface ChainCandidate {
  kind: UpstreamKind;
  /** Replay identity (`replayIdentity`): who may see this request's thinking again. */
  replay: string;
  accounts: Account[];
  client: ProviderAdapter;
  upstream: ProviderAdapter;
  /** The model-map target for this upstream, or null when nothing matches. */
  model: string | null;
}

export interface TranslateRequest {
  request: Request;
  body: Uint8Array;
  json: unknown;
}

/** How a vendor-mismatched candidate is served inside the hub's account loop. */
export interface Translation {
  /** Upstream-shaped request: its URL, headers and signal feed the upstream adapter. */
  request: Request;
  /** Upstream request body, in the upstream vendor's protocol. */
  body: Uint8Array;
  /** Turns the upstream response into the client's protocol. */
  toClient: (upstream: Response) => Promise<Response>;
  /** Request parts with no form in the upstream protocol, left out (plan 9, P4 risk c). */
  dropped?: string[];
}

/**
 * Cross-vendor seam (plan 4.3 step 4). Messages clients (Claude Code) behind a
 * Responses upstream (ChatGPT, a Responses key), and Responses clients (Codex,
 * omp, FX, nanocodex, Pi) behind a Messages key (P4). The upstream fetch follows
 * the client's abort signal. Returning a Response ends the request with it (no
 * failover): the request itself is unsupported.
 */
export function translateFor(
  candidate: ChainCandidate,
  { request, json }: TranslateRequest,
): Translation | Response {
  const { client } = candidate;
  const clientModel = requestModel(json) ?? "unknown";
  if (candidate.model === null)
    return client.errorResponse(
      400,
      `Gateway: no ${candidate.kind} model is mapped for ${clientModel}. Add one with bb gateway model-map set ${candidate.kind} <pattern> <model>.`,
    );
  const upstreamModel = candidate.model;
  // Key upstreams answer under their label (for example "kimi"), the rest under the vendor.
  const name =
    candidate.accounts[0]?.kind === "api-key" && candidate.accounts[0].baseUrl !== undefined
      ? candidate.accounts[0].label
      : candidate.upstream.upstreamName;
  const streaming =
    isRecord(json) &&
    (json.stream === true ||
      // The Codex WebSocket route asks for SSE through the accept header.
      (client.provider === "codex" &&
        json.stream !== false &&
        request.headers.get("accept")?.includes("text/event-stream") === true));
  const sse = { "content-type": "text/event-stream", "cache-control": "no-cache" };
  if (client.provider === "codex") {
    let translated: ReturnType<typeof responsesToMessages>;
    try {
      translated = responsesToMessages(json, {
        model: upstreamModel,
        stream: streaming,
        upstream: candidate.replay,
      });
    } catch (error) {
      if (error instanceof TranslateError) return client.errorResponse(400, error.message);
      throw error;
    }
    const options = {
      requestModel: clientModel,
      upstreamModel,
      upstream: candidate.replay,
      tools: translated.tools,
    };
    return {
      dropped: translated.dropped,
      request: new Request(new URL(`${ROUTE}/v1/messages`, request.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: streaming ? "text/event-stream" : "application/json",
          "anthropic-version": "2023-06-01",
        },
        signal: request.signal,
      }),
      body: new TextEncoder().encode(JSON.stringify(translated.body)),
      toClient: async (upstream) => {
        if (!upstream.ok || upstream.body === null)
          return translatedError(client, upstream, name);
        if (streaming)
          return new Response(
            streamFrom(
              messagesStreamToResponses(
                upstream.body as unknown as AsyncIterable<Uint8Array>,
                options,
              ),
            ),
            { headers: sse },
          );
        return Response.json(
          messagesJsonToResponses(await upstream.json().catch(() => null), options),
        );
      },
    };
  }
  let body: unknown;
  try {
    body = messagesToResponses(json, {
      model: upstreamModel,
      keepSampling: candidate.kind !== "chatgpt-oauth",
      upstream: candidate.replay,
    });
  } catch (error) {
    if (error instanceof TranslateError)
      return Response.json(error.body, { status: error.status });
    throw error;
  }
  // What the ported Codex adapter forwards; it adds the bearer and account id.
  const headers = new Headers({
    "content-type": "application/json",
    accept: "text/event-stream",
    originator: "bb",
  });
  const session = request.headers.get("x-claude-code-session-id");
  if (session !== null) headers.set("session_id", session);
  return {
    request: new Request(new URL(`${ROUTE}/v1/responses`, request.url), {
      method: "POST",
      headers,
      signal: request.signal,
    }),
    body: new TextEncoder().encode(JSON.stringify(body)),
    toClient: async (upstream) => {
      if (!upstream.ok || upstream.body === null)
        return translatedError(client, upstream, name);
      if (streaming)
        return new Response(
          streamFrom(
            responsesStreamToMessages(
              // Node's ReadableStream is async-iterable; the DOM typings lag.
              upstream.body as unknown as AsyncIterable<Uint8Array>,
              { requestModel: clientModel, upstream: candidate.replay },
            ),
          ),
          { headers: sse },
        );
      const completed = await completedResponse(upstream.body);
      if (completed === null)
        return client.errorResponse(
          502,
          `Gateway: the ${name} stream ended before a terminal event.`,
        );
      const message = responsesJsonToMessages(completed, {
        requestModel: clientModel,
        upstream: candidate.replay,
      });
      const errorType =
        message.type === "error" &&
        typeof message.error === "object" &&
        message.error !== null &&
        "type" in message.error
          ? message.error.type
          : null;
      return Response.json(message, {
        status:
          errorType === null
            ? 200
            : errorType === "invalid_request_error"
              ? 400
              : errorType === "rate_limit_error"
                ? 429
                : 529,
      });
    },
  };
}

export interface ThreadRouteStatus extends ThreadRoute {
  harness: Harness;
  /** Position of the bound upstream in the harness chain; -1 when it left the chain. */
  entryIndex: number;
  entry: string | null;
  upstreamLabel: string | null;
  upstreamKind: UpstreamKind | null;
}

type EntryResult =
  | { kind: "response"; response: Response; account: Account | null }
  | { kind: "failed"; failure: FailureSummary | null };

interface HubOptions {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  routes: ThreadRouteStore;
  hubTokens: HubTokenStore;
  getSettings: () => HubSettings;
  adapters: ReadonlyMap<PoolProvider, ProviderAdapter>;
  /** API-key upstreams with a base URL, by wire protocol (P4). */
  keyAdapters: ReadonlyMap<PoolProvider, ProviderAdapter>;
  fetch: typeof fetch;
  now: () => number;
  usageRefreshIntervalMs: number;
  drainTimeoutMs: number;
  onAccountsChanged: () => void;
  onUpstreamError: (provider: PoolProvider, error: unknown) => void;
  onRouteChanged: (threadId: string) => void;
  /** Once per thread and kind: what a translation left out. Never body content. */
  onDropped: (threadId: string, dropped: string[], upstream: UpstreamKind) => void;
  jevTimeoutMs: number;
}

interface SelectedAccount {
  account: Account;
  quota: AccountQuota;
  keepAffinity: boolean;
  accept: () => void;
}

interface ActiveAccount {
  accountId: string;
}

interface RoutingAttempt {
  binding: AccountBinding | null;
  active: ActiveAccount | null;
  pinnedAccountId: string | null;
}
interface UpstreamResult {
  response: Response;
  controller: AbortController;
  release: () => void;
}

interface RefreshBackoff {
  kind: "proactive" | "rejected";
  accessToken: string;
  retryAt: number;
  delayMs: number;
  error: TransientOAuthRefreshError;
}

type SecretUse = { kind: "normal" } | { kind: "rejected"; accessToken: string };

type SecretFlight =
  | { kind: "refresh"; use: SecretUse; result: Promise<AccountSecret> }
  | { kind: "rejection-check"; result: Promise<void> };

interface FailureSummary {
  status: number;
  message: string;
  headers: Record<string, string>;
}

class UpstreamConnectionError extends Error {}

export class AccountPoolHub {
  private accepting = false;
  private stopped = new AbortController();
  private readonly inFlightByAccount = new Map<string, number>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly refreshes = new Map<string, SecretFlight>();
  private readonly refreshBackoffs = new Map<string, RefreshBackoff>();
  private affinityBindings = new Map<string, AccountBinding>();
  private activeAccounts = new Map<PoolProvider, ActiveAccount>();
  private readonly usageRefreshes = new Map<string, Promise<void>>();
  private readonly lastUsageRefreshAt = new Map<string, number>();
  private readonly drainWaiters = new Set<() => void>();
  /** `threadId|kind` pairs already reported through onDropped. */
  private readonly droppedNoted = new Set<string>();

  constructor(private readonly options: HubOptions) {}

  async start(signal: AbortSignal): Promise<void> {
    this.affinityBindings = this.options.affinity.loadBindings(
      this.options.now() - AFFINITY_IDLE_TTL_MS,
      MAX_AFFINITY_BINDINGS,
    );
    this.activeAccounts = this.options.affinity.loadActiveAccounts();
    this.options.routes.prune(this.options.now() - THREAD_ROUTE_TTL_MS);
    this.stopped = new AbortController();
    this.accepting = true;
    while (!signal.aborted) {
      await this.refreshUsage();
      await waitForDelay(this.options.usageRefreshIntervalMs, signal);
    }
    await this.stop();
  }

  async authenticate(request: Request): Promise<ThreadIdentity | null> {
    // Codex sends x-bb-account-pool-token (core's pool config); FX sends a
    // ChatGPT bearer of its own, so the query token wins over any bearer.
    const token =
      request.headers.get("x-bb-model-gateway-token") ??
      request.headers.get("x-bb-account-pool-token") ??
      new URL(request.url).searchParams.get(TOKEN_QUERY) ??
      readBearer(request.headers.get("authorization"));
    return this.options.hubTokens.authenticate(token);
  }

  async importAccount(
    provider: PoolProvider,
  ): Promise<ImportedProviderAccount> {
    return this.adapter(provider).importAccount();
  }

  async handle(request: Request, provider: PoolProvider): Promise<Response> {
    const adapter = this.adapter(provider);
    const identity = await this.authenticate(request);
    if (identity === null) {
      return adapter.errorResponse(401, "Invalid Model Gateway bearer token.");
    }
    if (
      identity.harness === "acp-omp" &&
      routePath(request.url) === "/v1/models"
    )
      return Response.json({
        object: "list",
        data: ompModels(this.options.getSettings().modelMap).map((id) => ({
          id,
          object: "model",
          owned_by: "model-gateway",
        })),
      });
    return this.handleAuthenticated(
      await withoutClientCredentials(request, identity.harness),
      provider,
      identity,
    );
  }

  /** `provider` is the client protocol: claude = Messages, codex = Responses. */
  async handleAuthenticated(
    request: Request,
    provider: PoolProvider,
    identity: ThreadIdentity | null = null,
  ): Promise<Response> {
    const adapter = this.adapter(provider);
    if (!this.accepting)
      return adapter.errorResponse(
        503,
        "Model Gateway is not accepting requests.",
        STOPPING_RETRY_AFTER,
      );
    return this.forward(
      request,
      new Uint8Array(await request.arrayBuffer()),
      adapter,
      identity,
    );
  }

  /**
   * Test hook for the P1 acceptance run: treat an account as exhausted until
   * `until`. Null clears it, and also the hub's own hold (rate limit, key credit).
   */
  hold(accountId: string, until: number | null): void {
    this.options.routes.setHold(accountId, until);
    if (until !== null) return;
    const quota = this.options.quotas.get(accountId);
    if (quota.heldUntil !== null)
      this.options.quotas.put({ ...quota, heldUntil: null });
  }

  /** Accounts held now: the later of the test-hook hold and the hub's own hold. */
  async holds(): Promise<Array<{ account: Account; until: number }>> {
    const now = this.options.now();
    const hooks = new Map(
      this.options.routes.holds().map((hold) => [hold.accountId, hold.until]),
    );
    return (await this.options.accounts.list()).flatMap((account) => {
      const until = Math.max(
        hooks.get(account.id) ?? 0,
        this.options.quotas.get(account.id).heldUntil ?? 0,
      );
      return until > now ? [{ account, until }] : [];
    });
  }

  async threadStatus(threadId: string): Promise<ThreadRouteStatus | null> {
    const route = this.options.routes.get(threadId);
    if (route === null) return null;
    const harness = harnessSchema.parse(route.harness);
    const chain = this.options.getSettings().chains[harness];
    const accounts = await this.options.accounts.list();
    const entryIndex = expandChain(chain, accounts).findIndex((entry) =>
      entry.some((account) => account.id === route.upstreamId),
    );
    const account = accounts.find(({ id }) => id === route.upstreamId);
    return {
      ...route,
      harness,
      entryIndex,
      entry: chain[entryIndex] ?? null,
      upstreamLabel: account?.label ?? null,
      upstreamKind: account === undefined ? null : upstreamKind(account),
    };
  }

  /** Recently routed threads. */
  async recentRoutes(harness?: Harness): Promise<ThreadRouteStatus[]> {
    const since = this.options.now() - RECENT_ROUTE_MS;
    const found: ThreadRouteStatus[] = [];
    for (const route of this.options.routes.usedSince(since)) {
      if (harness !== undefined && route.harness !== harness) continue;
      const status = await this.threadStatus(route.threadId);
      if (status !== null) found.push(status);
    }
    return found;
  }

  /** Recently routed threads bound past chain entry 0. */
  async fallbacks(harness?: Harness): Promise<ThreadRouteStatus[]> {
    return (await this.recentRoutes(harness)).filter(({ entryIndex }) => entryIndex > 0);
  }

  /** True when a recently routed thread of this harness is bound past chain entry 0. */
  async onFallback(harness: Harness): Promise<boolean> {
    return (await this.fallbacks(harness)).length > 0;
  }

  async refreshUsage(accountId?: string, force = false): Promise<void> {
    const accounts = (await this.options.accounts.list()).filter(
      (account) =>
        account.enabled &&
        account.kind === "oauth" &&
        (accountId === undefined || account.id === accountId),
    );
    await Promise.all(
      accounts.map((account) => this.refreshAccountUsage(account, force)),
    );
  }

  private async refreshAccountUsage(
    account: Account,
    force: boolean,
  ): Promise<void> {
    const adapter = this.adapter(account.provider);
    if (
      adapter.refreshUsage === undefined ||
      (this.inFlightByAccount.get(account.id) ?? 0) > 0
    )
      return;
    const now = this.options.now();
    const last = this.lastUsageRefreshAt.get(account.id);
    if (
      !force &&
      last !== undefined &&
      now - last < this.options.usageRefreshIntervalMs
    )
      return;
    const running = this.usageRefreshes.get(account.id);
    if (running !== undefined) return running;
    this.lastUsageRefreshAt.set(account.id, now);
    const refresh = adapter
      .refreshUsage({
        account,
        freshSecret: () =>
          this.freshSecret(account, adapter, { kind: "normal" }),
        accounts: this.options.accounts,
        quotas: this.options.quotas,
        fetch: this.options.fetch,
        now: this.options.now,
      })
      .catch(() => undefined)
      .finally(() => this.usageRefreshes.delete(account.id));
    this.usageRefreshes.set(account.id, refresh);
    return refresh;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.stopped.abort(new Error("Model Gateway stopped accepting requests."));
    if (this.inFlightCount() === 0) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      new Promise<void>((resolve) => this.drainWaiters.add(resolve)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.options.drainTimeoutMs);
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
    if (this.inFlightCount() === 0) return;
    for (const controller of this.activeControllers) {
      controller.abort(
        new Error(
          "Model Gateway stopped before the upstream response completed.",
        ),
      );
    }
  }

  async status(): Promise<
    Omit<PoolStatus, "routedThreadsWithoutLocalLogin" | "routing">
  > {
    const settings = this.options.getSettings();
    const now = this.options.now();
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    return {
      route: ROUTE,
      enabledAccountCount: accounts.filter((account) => account.enabled).length,
      inFlight: this.inFlightCount(),
      accepting: this.accepting,
      hosts: await this.options.hubTokens.list(),
      accounts: accounts.map((account) => {
        const quota = this.options.quotas.get(account.id);
        return {
          ...account,
          lastUsedHostName: null,
          fiveHourUtilization: quota.fiveHourUtilization,
          fiveHourResetAt: quota.fiveHourResetAt,
          fiveHourStatus: quota.fiveHourStatus,
          sevenDayUtilization: quota.sevenDayUtilization,
          sevenDayResetAt: quota.sevenDayResetAt,
          sevenDayStatus: quota.sevenDayStatus,
          representativeClaim: quota.representativeClaim,
          familyWeekly: quota.familyWeekly,
          limitWindows: quota.limitWindows,
          observedAt: quota.observedAt,
          heldUntil: quota.heldUntil,
          error: quota.error,
          inFlight: this.inFlightByAccount.get(account.id) ?? 0,
          status: accountStatus(account, quota, settings.switchThreshold, now),
        };
      }),
    };
  }

  private async forward(
    request: Request,
    body: Uint8Array,
    client: ProviderAdapter,
    identity: ThreadIdentity | null,
  ): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.stopped.signal]);
    const settings = this.options.getSettings();
    const now = this.options.now();
    const harness =
      identity?.harness ?? (client.provider === "claude" ? "claude-code" : "codex");
    const path = routePath(request.url);
    const countTokens = path === "/v1/messages/count_tokens";
    // omp, FX and nanocodex speak Responses but not the Codex backend's dialect.
    const fitResponses = client.provider === "codex" && harness !== "codex";
    let apiKeyOnly: string | null = null;
    const allAccounts = await this.options.accounts.list();
    const entries = expandChain(settings.chains[harness], allAccounts).map(
      (accounts) =>
        accounts.filter((account) =>
          isLegalUpstream(upstreamKind(account), identity?.harness ?? null, path),
        ),
    );
    const route =
      identity === null ? null : this.options.routes.get(identity.threadId);
    let json = parseJson(body);
    // P5: Jev's pick replaces the client model; the chain then routes it as usual.
    const auto = countTokens
      ? null
      : await this.autoPick(harness, json, route, entries, allAccounts, signal);
    if (
      auto?.model != null &&
      isRecord(json) &&
      json.model !== auto.model &&
      onAutoLadder(harness, autoLadder(harness, settings.modelMap), requestModel(json))
    ) {
      json = { ...json, model: auto.model };
      body = new TextEncoder().encode(JSON.stringify(json));
    }
    const parsed = client.parseRequest(body, request.headers);
    const family = parsed.family;
    const model = requestModel(json);
    const boundIndex =
      route === null
        ? -1
        : entries.findIndex((accounts) =>
            accounts.some((account) => account.id === route.upstreamId),
          );
    const rejected = new Map<string, number | null>();
    // A primary that reset early (hold cleared, usage refreshed) ends stickiness.
    const primaryBlocked =
      boundIndex > 0 &&
      this.entryResetAt(entries[0] ?? [], rejected, family) !== null;
    const { order, sticky } = orderEntries(
      entries.length,
      boundIndex,
      primaryBlocked ? (route?.stickyUntil ?? null) : null,
      isNewUserTurn(json),
      now,
    );
    let estimate: number | null = null;
    let contextBlocked = false;
    let served = false;
    let failure: FailureSummary | null = null;
    try {
      for (const index of order) {
        for (const accounts of candidateGroups(entries[index] ?? [])) {
          const first = accounts[0];
          if (first === undefined) continue;
          const upstream = this.upstreamAdapter(first);
          const kind = upstreamKind(first);
          const cross = upstream.provider !== client.provider;
          const isKey = first.kind === "api-key";
          // A compatible key's `<kind>:<label>` map wins over its kind's map.
          const mapKey = first.baseUrl === undefined ? kind : first;
          const candidate: ChainCandidate = {
            kind,
            replay: replayIdentity(first),
            accounts: accounts.filter((account) => {
              const held = this.options.routes.holdUntil(account.id);
              return held === null || held <= now;
            }),
            client,
            upstream,
            // Keys take the model map, else the client's model unchanged (for
            // example nanocodex kimi-k3 on a Kimi key); ChatGPT needs a mapping.
            model: cross
              ? (mapModel(settings.modelMap, mapKey, model) ?? (isKey ? model : null))
              : isKey || fitResponses
                ? gatewayModel(settings.modelMap, mapKey, model)
                : model,
          };
          // ChatGPT cannot serve these; a later key entry can.
          if (
            kind === "chatgpt-oauth" &&
            fitResponses &&
            needsApiKeyUpstream(candidate.model)
          ) {
            apiKeyOnly ??= candidate.model;
            continue;
          }
          // Same protocol: the upstream knows its real window and answers with
          // its own too-long error, which the harness compacts on. Guess only
          // for translated fallbacks.
          const window = cross ? contextWindow(candidate.model, request.headers) : null;
          if (window !== null && candidate.accounts.length > 0) {
            estimate ??= estimateTokens(json);
            if (estimate > window) {
              contextBlocked = true;
              continue;
            }
          }
          if (candidate.accounts.length === 0) continue;
          served = true;
          let translation: Translation | null = null;
          // Same protocol: thinking and reasoning go only to the upstream that minted them.
          const replay = cross ? json : fitReplay(json, candidate.replay);
          let entryParsed = parsed;
          if (countTokens && (cross || first.baseUrl !== undefined)) {
            // Only Anthropic counts tokens; answer the other vendors locally.
            estimate ??= estimateTokens(json);
            return Response.json({ input_tokens: estimate });
          }
          if (cross) {
            const translated = translateFor(candidate, { request, body, json });
            if (!("toClient" in translated)) return translated;
            translation = translated;
            if (identity !== null && translated.dropped !== undefined)
              this.noteDropped(identity.threadId, translated.dropped, candidate.kind);
          } else if (isRecord(replay) && candidate.model !== null) {
            // Same protocol: ChatGPT gets the Codex backend's dialect; a key gets
            // its mapped model and keeps every other field.
            const fitted =
              kind === "chatgpt-oauth" && fitResponses
                ? fitForChatGpt(replay, candidate.model)
                : isKey && candidate.model !== model
                  ? { ...replay, model: candidate.model }
                  : replay !== json
                    ? replay
                    : null;
            if (fitted !== null)
              entryParsed = client.parseRequest(
                new TextEncoder().encode(JSON.stringify(fitted)),
                request.headers,
              );
          }
          const result = await this.forwardEntry(
            request,
            entryParsed,
            candidate,
            translation,
            identity?.hostId ?? null,
            rejected,
            signal,
          );
          if (result.kind === "failed") {
            failure = result.failure ?? failure;
            continue;
          }
          if (identity !== null && result.account !== null && !countTokens) {
            this.bindThread(identity, route, {
              index,
              boundIndex,
              sticky,
              account: result.account,
              model: candidate.model,
              auto,
              primary: entries[0] ?? [],
              rejected,
              family,
            });
          }
          // A compatible key's own thinking and reasoning go back wrapped (fitReplay).
          return cross ||
            candidate.replay ===
              (client.provider === "claude" ? ANTHROPIC_REPLAY : CHATGPT_REPLAY)
            ? result.response
            : await wrapKeyResponse(result.response, candidate.replay);
        }
      }
      signal.throwIfAborted();
      // A fallback that could not fit is the reason, even after the primary failed.
      if (contextBlocked && estimate !== null)
        return client.errorResponse(400, contextExceededMessage(estimate));
      if (apiKeyOnly !== null && !served)
        return client.errorResponse(400, apiKeyUpstreamMessage(apiKeyOnly));
      return failure === null
        ? this.noEligibleResponse(entries.flat(), family, client)
        : client.errorResponse(
            failure.status,
            failure.message,
            failure.headers,
          );
    } catch (error) {
      if (!signal.aborted) throw error;
      return client.errorResponse(
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Model Gateway request was canceled."
          : "Model Gateway stopped accepting requests.",
        request.signal.aborted ? undefined : STOPPING_RETRY_AFTER,
      );
    }
  }

  /**
   * Records the thread's chain binding (plan 4.5). A new binding past entry 0
   * is sticky until the primary entry resets; a sticky thread keeps its time.
   */
  private bindThread(
    identity: ThreadIdentity,
    route: ThreadRoute | null,
    served: {
      index: number;
      boundIndex: number;
      sticky: boolean;
      account: Account;
      model: string | null;
      auto: JevPick | null;
      primary: readonly Account[];
      rejected: ReadonlyMap<string, number | null>;
      family: ModelFamily;
    },
  ): void {
    const now = this.options.now();
    const same = route !== null && served.index === served.boundIndex;
    const stickyUntil =
      served.index === 0
        ? null
        : same && served.sticky
          ? route.stickyUntil
          : this.entryResetAt(served.primary, served.rejected, served.family);
    this.options.routes.put({
      threadId: identity.threadId,
      harness: identity.harness,
      upstreamId: served.account.id,
      boundAt: same ? route.boundAt : now,
      stickyUntil,
      reason:
        served.index === 0
          ? "primary"
          : stickyUntil === null
            ? "fallback"
            : "primary exhausted",
      usedAt: now,
      model: served.model,
      autoModel: served.auto?.model ?? null,
      autoReason: served.auto?.reason ?? null,
    });
    if (
      route?.upstreamId !== served.account.id ||
      route.model !== served.model ||
      route.autoReason !== (served.auto?.reason ?? null)
    )
      this.options.onRouteChanged(identity.threadId);
  }

  /**
   * The thread's Jev pick (plan WP5.1): asked on a new user turn that carries
   * client tools, else the stored pick. Null when auto is off for the harness.
   * Candidates are ladder models some legal, unheld, unexhausted account can serve.
   */
  private async autoPick(
    harness: Harness,
    json: unknown,
    route: ThreadRoute | null,
    entries: readonly Account[][],
    accounts: readonly Account[],
    signal: AbortSignal,
  ): Promise<JevPick | null> {
    const settings = this.options.getSettings();
    if (!settings.auto.harnesses.includes(harness)) return null;
    const ladder = autoLadder(harness, settings.modelMap);
    if (
      !isNewUserTurn(json) ||
      !hasClientTools(json) ||
      !onAutoLadder(harness, ladder, requestModel(json))
    )
      return route?.autoReason == null
        ? null
        : { model: route.autoModel, reason: route.autoReason };
    const now = this.options.now();
    const candidates = ladder.filter((model) =>
      entries.flat().some((account) => {
        const held = this.options.routes.holdUntil(account.id);
        const quota = this.options.quotas.get(account.id);
        return (
          (held === null || held <= now) &&
          quota.error === null &&
          !isQuotaExhausted(quota, modelFamily(model), settings.switchThreshold, now)
        );
      }),
    );
    if (candidates.length === 0)
      return { model: null, reason: "fail open: no candidate available" };
    if (candidates.length === 1)
      return { model: candidates[0] ?? null, reason: "only candidate" };
    const key = accounts.find(
      (account) =>
        upstreamKind(account) === "responses-compatible-key" &&
        account.label === settings.auto.key,
    );
    if (key?.baseUrl === undefined)
      return { model: null, reason: "fail open: no Jev key" };
    const secret = await this.options.accounts.readSecret(key.id).catch(() => null);
    if (secret?.kind !== "api-key")
      return { model: null, reason: "fail open: no Jev key" };
    return askJev({
      fetch: this.options.fetch,
      baseUrl: key.baseUrl,
      apiKey: secret.apiKey,
      model: settings.auto.model,
      prompt: lastUserText(json),
      candidates,
      signal,
      timeoutMs: this.options.jevTimeoutMs,
    });
  }

  private noteDropped(
    threadId: string,
    dropped: readonly string[],
    upstream: UpstreamKind,
  ): void {
    const fresh = dropped.filter(
      (kind) => !this.droppedNoted.has(`${threadId}|${kind}`),
    );
    if (fresh.length === 0) return;
    // ponytail: cleared wholesale at the cap; a busy host may log a thread twice.
    if (this.droppedNoted.size > MAX_AFFINITY_BINDINGS) this.droppedNoted.clear();
    for (const kind of fresh) this.droppedNoted.add(`${threadId}|${kind}`);
    this.options.onDropped(threadId, fresh, upstream);
  }

  /** Earliest time any account of the entry is usable again; null if unknown. */
  private entryResetAt(
    accounts: readonly Account[],
    rejected: ReadonlyMap<string, number | null>,
    family: ModelFamily,
  ): number | null {
    const settings = this.options.getSettings();
    const now = this.options.now();
    let earliest: number | null = null;
    for (const account of accounts) {
      const hold = this.options.routes.holdUntil(account.id);
      const quota = rejected.has(account.id)
        ? (rejected.get(account.id) ?? null)
        : (exhaustedUntil(
            this.options.quotas.get(account.id),
            family,
            settings.switchThreshold,
            now,
          )?.resetAt ?? null);
      const until = Math.max(
        hold !== null && hold > now ? hold : 0,
        quota ?? 0,
      );
      if (until <= now) return null;
      earliest = Math.min(earliest ?? until, until);
    }
    return earliest;
  }

  private async forwardEntry(
    request: Request,
    parsed: ReturnType<ProviderAdapter["parseRequest"]>,
    candidate: ChainCandidate,
    translation: Translation | null,
    hostId: string | null,
    rejected: Map<string, number | null>,
    signal: AbortSignal,
  ): Promise<EntryResult> {
    const adapter = candidate.upstream;
    const attempted = new Set<string>();
    const waited = new Set<string>();
    const routing: RoutingAttempt = {
      binding: null,
      active: null,
      pinnedAccountId: null,
    };
    let previousAccountId: string | null = null;
    let failure: FailureSummary | null = null;
    const candidateIds = new Set(
      candidate.accounts.map((account) => account.id),
    );
    const family = parsed.family;
    const affinityKey =
      hostId === null || parsed.affinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.affinityId]);
    const parentAffinityKey =
      affinityKey === null || parsed.parentAffinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.parentAffinityId]);
    {
      while (attempted.size < candidateIds.size) {
        signal.throwIfAborted();
        const selected = await this.select(
          adapter.provider,
          candidateIds,
          attempted,
          family,
          affinityKey,
          parentAffinityKey,
          previousAccountId,
          routing,
          signal,
        );
        if (selected === null) break;
        const heldMs = (selected.quota.heldUntil ?? 0) - this.options.now();
        if (heldMs > 0) {
          if (heldMs > MAX_INLINE_HOLD_MS || waited.has(selected.account.id)) {
            failure = {
              status: 429,
              message:
                "The current Model Gateway account is temporarily rate limited.",
              headers: { "retry-after": String(Math.ceil(heldMs / 1_000)) },
            };
            // A pinned account on a long hold moves on to the next chain entry.
            if (selected.keepAffinity) return { kind: "failed", failure };
            attempted.add(selected.account.id);
            previousAccountId = selected.account.id;
            continue;
          }
          waited.add(selected.account.id);
          await waitForDelay(heldMs, signal);
          continue;
        }
        previousAccountId = selected.account.id;
        attempted.add(selected.account.id);
        if (hostId !== null) {
          const changed = await this.options.accounts.recordUsed(
            selected.account.id,
            this.options.now(),
            hostId,
          );
          if (changed) this.options.onAccountsChanged();
        }
        let secret: AccountSecret;
        try {
          signal.throwIfAborted();
          secret = await abortable(
            this.freshSecret(selected.account, adapter, { kind: "normal" }),
            signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof TransientOAuthRefreshError) {
            failure = { status: 503, message: error.message, headers: {} };
          } else {
            this.markError(selected.account.id, errorMessage(error));
          }
          continue;
        }
        let authRetried = false;
        let paced = waited.has(selected.account.id);
        while (true) {
          signal.throwIfAborted();
          let upstream: UpstreamResult;
          try {
            upstream = await this.fetchUpstream(
              translation?.request ?? request,
              translation?.body ?? parsed.forAccount(selected.account),
              selected.account,
              secret,
              adapter,
            );
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof UpstreamConnectionError)) throw error;
            failure = {
              status: 502,
              message:
                "Model Gateway could not reach " + adapter.upstreamName + ".",
              headers: {},
            };
            break;
          }
          if (request.signal.aborted) {
            await this.discardUpstream(upstream, false);
            signal.throwIfAborted();
          }
          const { response } = upstream;
          const observed = adapter.quotaFromHeaders(
            selected.account.id,
            response.headers,
            this.options.quotas.get(selected.account.id),
            family,
            this.options.now(),
          );
          this.options.quotas.put(observed);
          // A key out of credit sits out for a while; the chain moves on.
          if (
            selected.account.kind === "api-key" &&
            !response.ok &&
            (await isCreditExhausted(response))
          ) {
            const until = this.options.now() + CREDIT_BENCH_MS;
            this.options.quotas.put({ ...observed, heldUntil: until });
            rejected.set(selected.account.id, until);
            failure = {
              status: 429,
              message:
                (await this.discardUpstream(upstream, true)) ||
                `${selected.account.label} is out of credit.`,
              headers: { "retry-after": String(CREDIT_BENCH_MS / 1_000) },
            };
            break;
          }
          if (response.status === 429) {
            const exhausted = responseExhaustion(
              adapter,
              response.status,
              response.headers,
              family,
              { accountId: selected.account.id, ...EMPTY_QUOTA },
              this.options.now(),
            );
            if (exhausted !== null) {
              rejected.set(selected.account.id, exhausted.resetAt);
              await this.discardUpstream(upstream, false);
              break;
            }
            const waitMs = retryAfterMilliseconds(
              response.headers.get("retry-after"),
              this.options.now(),
            );
            this.options.quotas.put({
              ...observed,
              heldUntil: this.options.now() + waitMs,
            });
            if (!paced && waitMs <= MAX_INLINE_HOLD_MS) {
              paced = true;
              await this.discardUpstream(upstream, false);
              await waitForDelay(waitMs, signal);
              continue;
            }
            // Short holds keep the single wait above. A pinned account that
            // stays limited past it moves on to the next chain entry.
            if (!selected.keepAffinity || waitMs > MAX_INLINE_HOLD_MS) {
              failure = {
                status: 429,
                message: await this.discardUpstream(upstream, true),
                headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) },
              };
              if (selected.keepAffinity) return { kind: "failed", failure };
              break;
            }
          }
          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 408 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504 ||
            response.status === 529
          ) {
            const retryAfter = response.headers.get("retry-after");
            const detail = await this.discardUpstream(upstream, true);
            signal.throwIfAborted();
            failure = {
              status: response.status,
              message:
                detail ||
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  ".",
              headers: retryAfter === null ? {} : { "retry-after": retryAfter },
            };
            if (
              response.status === 401 &&
              secret.kind === "oauth" &&
              !authRetried
            ) {
              authRetried = true;
              try {
                secret = await abortable(
                  this.freshSecret(selected.account, adapter, {
                    kind: "rejected",
                    accessToken: secret.accessToken,
                  }),
                  signal,
                );
              } catch (error) {
                signal.throwIfAborted();
                if (error instanceof TransientOAuthRefreshError) {
                  failure = {
                    status: 503,
                    message: error.message,
                    headers: {},
                  };
                } else {
                  await this.markAuthError(
                    selected.account,
                    secret,
                    errorMessage(error),
                    signal,
                  );
                }
                break;
              }
              continue;
            }
            if (response.status === 401 || response.status === 403) {
              await this.markAuthError(
                selected.account,
                secret,
                failure.message,
                signal,
              );
            }
            break;
          }
          if (response.ok) selected.accept();
          const passthrough = this.clientResponse(upstream);
          return {
            kind: "response",
            response:
              translation === null
                ? passthrough
                : await translation.toClient(passthrough),
            account: response.ok ? selected.account : null,
          };
        }
      }
      signal.throwIfAborted();
      return { kind: "failed", failure };
    }
  }

  private async discardUpstream(
    upstream: UpstreamResult,
    readDetail: boolean,
  ): Promise<string> {
    const reader = upstream.response.body?.getReader();
    if (reader === undefined) {
      upstream.controller.abort();
      upstream.release();
      return "";
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve(""), FAILURE_DISPOSAL_TIMEOUT_MS);
    });
    let detail = "";
    try {
      if (!readDetail) return detail;
      return await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          while (bytes < MAX_FAILURE_DETAIL_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const part = chunk.value.subarray(
              0,
              MAX_FAILURE_DETAIL_BYTES - bytes,
            );
            bytes += part.byteLength;
            detail += decoder.decode(part, { stream: true });
          }
          return (detail + decoder.decode()).trim();
        })().catch(() => detail.trim()),
        deadline,
      ]);
    } finally {
      upstream.controller.abort();
      await Promise.race([reader.cancel().catch(() => undefined), deadline]);
      clearTimeout(timeout);
      upstream.release();
    }
  }

  private async markAuthError(
    account: Account,
    rejected: AccountSecret,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (rejected.kind !== "oauth") {
      this.markError(account.id, message);
      return;
    }
    while (true) {
      signal.throwIfAborted();
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        await abortable(
          existing.result.then(
            () => undefined,
            () => undefined,
          ),
          signal,
        );
        continue;
      }
      const flight: SecretFlight = {
        kind: "rejection-check",
        result: this.options.accounts
          .readSecret(account.id)
          .then((current) => {
            const backoff = this.refreshBackoffs.get(account.id);
            if (
              !signal.aborted &&
              current.kind === "oauth" &&
              current.accessToken === rejected.accessToken &&
              !(
                backoff?.kind === "rejected" &&
                backoff.accessToken === current.accessToken
              )
            ) {
              this.markError(account.id, message);
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      await abortable(flight.result, signal);
      return;
    }
  }

  private async select(
    provider: PoolProvider,
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
    affinityKey: string | null,
    parentAffinityKey: string | null,
    previousAccountId: string | null,
    routing: RoutingAttempt,
    signal: AbortSignal,
  ): Promise<SelectedAccount | null> {
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    signal.throwIfAborted();
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const available = accounts
      .filter((account) => account.provider === provider && account.enabled)
      .map((account) => ({
        account,
        quota: this.options.quotas.get(account.id),
      }))
      .filter(({ quota }) => quota.error === null)
      .filter(({ quota }) => !isSharedQuotaExhausted(quota, threshold, now));
    const eligible = available.filter(
      ({ quota }) => !isQuotaExhausted(quota, family, threshold, now),
    );
    const unattempted = eligible.filter(
      ({ account }) =>
        candidateIds.has(account.id) && !attempted.has(account.id),
    );
    const candidates = unattempted.filter(
      ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
    );
    let binding =
      affinityKey === null ? undefined : this.affinityBindings.get(affinityKey);
    const boundAccountId =
      binding !== undefined && now - binding.lastUsedAt < AFFINITY_IDLE_TTL_MS
        ? binding.accountId
        : null;
    const bound =
      boundAccountId !== null
        ? eligible.find(({ account }) => account.id === boundAccountId)
        : undefined;
    let inherited: (typeof candidates)[number] | undefined;
    if (bound === undefined && parentAffinityKey !== null) {
      const parent = this.affinityBindings.get(parentAffinityKey);
      if (
        parent !== undefined &&
        now - parent.lastUsedAt < AFFINITY_IDLE_TTL_MS
      ) {
        inherited = unattempted.find(
          ({ account }) => account.id === parent.accountId,
        );
      }
    }
    let active = this.activeAccounts.get(provider);
    const activeAccount = eligible.find(
      ({ account }) => account.id === active?.accountId,
    );
    const anchorId = previousAccountId ?? boundAccountId ?? active?.accountId;
    const anchorIndex = accounts.findIndex(
      (account) => account.id === anchorId,
    );
    const ordered = [
      ...accounts.slice(anchorIndex + 1),
      ...accounts.slice(0, anchorIndex + 1),
    ];
    const next = ordered
      .map((account) =>
        candidates.find((candidate) => candidate.account.id === account.id),
      )
      .find((candidate) => candidate !== undefined);
    const selected =
      bound !== undefined && unattempted.includes(bound)
        ? bound
        : (inherited ??
          (boundAccountId === null &&
          previousAccountId === null &&
          activeAccount !== undefined &&
          unattempted.includes(activeAccount)
            ? activeAccount
            : next) ??
          null);
    if (selected === null) return null;
    if (routing.active === null)
      routing.pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;
    if (affinityKey !== null && binding === undefined) {
      binding = { accountId: selected.account.id, lastUsedAt: now };
      this.affinityBindings.set(affinityKey, binding);
    }
    if (binding !== undefined && binding.accountId === selected.account.id) {
      binding.lastUsedAt = now;
      if (affinityKey !== null) {
        this.affinityBindings.delete(affinityKey);
        this.affinityBindings.set(affinityKey, binding);
      }
    }
    while (this.affinityBindings.size > MAX_AFFINITY_BINDINGS) {
      const oldest = this.affinityBindings.keys().next();
      if (!oldest.done) {
        this.affinityBindings.delete(oldest.value);
        this.options.affinity.removeBinding(oldest.value);
      }
    }
    if (active === undefined) {
      active = { accountId: selected.account.id };
      this.activeAccounts.set(provider, active);
    }
    routing.binding ??= binding ?? null;
    routing.active ??= active;
    const familyDetour = (accountId: string | null) =>
      available.some(({ account }) => account.id === accountId) &&
      !eligible.some(({ account }) => account.id === accountId);
    const rebind =
      affinityKey !== null &&
      !familyDetour(boundAccountId) &&
      (bound === undefined ||
        bound.account.id === selected.account.id ||
        (binding === routing.binding && attempted.has(bound.account.id)));
    const advance =
      !familyDetour(active.accountId) &&
      (activeAccount === undefined ||
        active.accountId === selected.account.id ||
        (active === routing.active && attempted.has(active.accountId)));
    return {
      ...selected,
      keepAffinity: selected.account.id === routing.pinnedAccountId,
      accept: () => {
        if (rebind && this.affinityBindings.get(affinityKey) === binding) {
          const accepted = {
            accountId: selected.account.id,
            lastUsedAt: this.options.now(),
          };
          this.options.affinity.putBinding(affinityKey, accepted);
          this.affinityBindings.delete(affinityKey);
          this.affinityBindings.set(affinityKey, accepted);
        }
        if (advance && this.activeAccounts.get(provider) === active) {
          this.options.affinity.putActiveAccount(provider, selected.account.id);
          this.activeAccounts.set(provider, { accountId: selected.account.id });
        }
      },
    };
  }

  private async freshSecret(
    account: Account,
    adapter: ProviderAdapter,
    use: SecretUse,
  ): Promise<AccountSecret> {
    while (true) {
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        if (existing.kind === "rejection-check") {
          await existing.result;
          continue;
        }
        let secret: AccountSecret;
        try {
          secret = await existing.result;
        } catch (error) {
          const current = this.refreshes.get(account.id);
          if (current !== undefined && current !== existing) continue;
          throw error;
        }
        const current = this.refreshes.get(account.id);
        if (current !== undefined && current !== existing) continue;
        const backoff = this.refreshBackoffs.get(account.id);
        if (
          secret.kind === "oauth" &&
          backoff?.accessToken === secret.accessToken &&
          backoff.kind === "rejected"
        )
          continue;
        if (
          use.kind === "normal" ||
          secret.kind !== "oauth" ||
          secret.accessToken !== use.accessToken ||
          (existing.use.kind === "rejected" &&
            existing.use.accessToken === use.accessToken)
        ) {
          return secret;
        }
        continue;
      }
      const flight: Extract<SecretFlight, { kind: "refresh" }> = {
        kind: "refresh",
        use,
        result: this.options.accounts
          .readSecret(account.id)
          .then(async (secret) => {
            let backoff = this.refreshBackoffs.get(account.id);
            if (
              secret.kind !== "oauth" ||
              backoff?.accessToken !== secret.accessToken
            ) {
              this.refreshBackoffs.delete(account.id);
              backoff = undefined;
            }
            const explicitlyRejected =
              secret.kind === "oauth" &&
              use.kind === "rejected" &&
              secret.accessToken === use.accessToken;
            const forceRefresh =
              explicitlyRejected || backoff?.kind === "rejected";
            if (forceRefresh && secret.kind === "oauth") {
              flight.use = {
                kind: "rejected",
                accessToken: secret.accessToken,
              };
            }
            const error = this.options.quotas.get(account.id).error;
            if (error !== null) throw new Error(error);
            if (
              backoff !== undefined &&
              this.options.now() < backoff.retryAt &&
              (!explicitlyRejected || backoff.kind === "rejected")
            ) {
              if (
                !forceRefresh &&
                secret.kind === "oauth" &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw backoff.error;
            }
            try {
              const result = await adapter.refreshSecret({
                account,
                secret,
                accounts: this.options.accounts,
                quotas: this.options.quotas,
                fetch: this.options.fetch,
                now: this.options.now,
                forceRefresh,
              });
              this.refreshBackoffs.delete(account.id);
              if (result.refreshed) {
                const quota = this.options.quotas.get(account.id);
                this.options.quotas.put({ ...quota, error: null });
              }
              return result.secret;
            } catch (error) {
              if (
                !(error instanceof TransientOAuthRefreshError) ||
                secret.kind !== "oauth"
              ) {
                this.refreshBackoffs.delete(account.id);
                throw error;
              }
              const delayMs = Math.min(
                MAX_REFRESH_BACKOFF_MS,
                Math.max(
                  backoff === undefined ? 1_000 : backoff.delayMs * 2,
                  error.retryAfterMs,
                ),
              );
              this.refreshBackoffs.delete(account.id);
              this.refreshBackoffs.set(account.id, {
                kind: forceRefresh ? "rejected" : "proactive",
                accessToken: secret.accessToken,
                retryAt: this.options.now() + delayMs,
                delayMs,
                error,
              });
              while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
                const oldest = this.refreshBackoffs.keys().next();
                if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
              }
              if (
                !forceRefresh &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw error;
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      return flight.result;
    }
  }

  private async fetchUpstream(
    request: Request,
    body: Uint8Array,
    account: Account,
    secret: AccountSecret,
    adapter: ProviderAdapter,
  ): Promise<UpstreamResult> {
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    this.activeControllers.add(controller);
    this.increment(account.id);
    if (request.signal.aborted) abortFromRequest();
    else
      request.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      request.signal.removeEventListener("abort", abortFromRequest);
      this.activeControllers.delete(controller);
      this.decrement(account.id);
    };
    try {
      const upstreamBody = new ArrayBuffer(body.byteLength);
      new Uint8Array(upstreamBody).set(body);
      const url = adapter.upstreamUrl(
        request,
        this.options.getSettings(),
        account,
      );
      const headers = adapter.requestHeaders(request.headers, account, secret);
      const response = await this.options
        .fetch(url, {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: upstreamBody }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            this.options.onUpstreamError(adapter.provider, cause);
          throw new UpstreamConnectionError("Upstream connection failed.", {
            cause,
          });
        });
      return { response, controller, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private clientResponse(upstream: UpstreamResult): Response {
    const headers = new Headers();
    for (const [name, value] of upstream.response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        headers.append(name, value);
    }
    if (upstream.response.body === null) {
      upstream.release();
      return new Response(null, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers,
      });
    }
    const reader = upstream.response.body.getReader();
    const eventStream =
      upstream.response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "text/event-stream";
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            upstream.release();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          upstream.release();
          if (!eventStream) {
            controller.error(
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage(error) } })}\n\n`,
            ),
          );
          controller.close();
        }
      },
      async cancel() {
        upstream.controller.abort();
        await reader.cancel().catch(() => undefined);
        upstream.release();
      },
    });
    return new Response(body, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers,
    });
  }

  private noEligibleResponse(
    accounts: readonly Account[],
    family: ModelFamily,
    adapter: ProviderAdapter,
  ): Response {
    if (!accounts.some((account) => account.enabled)) {
      return adapter.errorResponse(
        503,
        "Model Gateway has no enabled account",
      );
    }
    const now = this.options.now();
    const next = accounts
      .filter((account) => account.enabled)
      .flatMap((account) => {
        const quota = this.options.quotas.get(account.id);
        return [
          quota.heldUntil,
          quota.fiveHourResetAt,
          quota.sevenDayResetAt,
          ...quota.limitWindows.map((window) => window.resetAt),
          governingWeeklyResetAt(quota, family),
        ].filter((value): value is number => value !== null && value > now);
      })
      .sort((left, right) => left - right)[0];
    const retryAfter = Math.max(
      1,
      Math.ceil(((next ?? now + 1_000) - now) / 1_000),
    );
    return adapter.errorResponse(
      429,
      "No Model Gateway account is currently eligible.",
      { "retry-after": String(retryAfter) },
    );
  }

  private markError(accountId: string, message: string): void {
    const quota = this.options.quotas.get(accountId);
    this.options.quotas.put({ ...quota, error: message.slice(0, 1_000) });
  }

  private adapter(provider: PoolProvider): ProviderAdapter {
    const adapter = this.options.adapters.get(provider);
    if (adapter === undefined)
      throw new Error(`Missing ${provider} Model Gateway adapter.`);
    return adapter;
  }

  /** The adapter that talks to this account: API keys with a base URL use the key adapter. */
  private upstreamAdapter(account: Account): ProviderAdapter {
    if (account.baseUrl === undefined) return this.adapter(account.provider);
    const adapter = this.options.keyAdapters.get(account.provider);
    if (adapter === undefined)
      throw new Error(`Missing ${account.provider} key adapter.`);
    return adapter;
  }

  private increment(accountId: string): void {
    this.inFlightByAccount.set(
      accountId,
      (this.inFlightByAccount.get(accountId) ?? 0) + 1,
    );
  }

  private decrement(accountId: string): void {
    const next = Math.max(0, (this.inFlightByAccount.get(accountId) ?? 1) - 1);
    if (next === 0) this.inFlightByAccount.delete(accountId);
    else this.inFlightByAccount.set(accountId, next);
    if (this.inFlightCount() !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private inFlightCount(): number {
    let total = 0;
    for (const count of this.inFlightByAccount.values()) total += count;
    return total;
  }
}

export function createHub(options: {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  routes: ThreadRouteStore;
  hubTokens: HubTokenStore;
  getSettings: () => HubSettings;
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  importClaudeCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  usageUrl?: string;
  profileUrl?: string;
  usageRefreshIntervalMs?: number;
  drainTimeoutMs?: number;
  onAccountsChanged?: () => void;
  onUpstreamError?: (provider: PoolProvider, error: unknown) => void;
  onRouteChanged?: (threadId: string) => void;
  onDropped?: (threadId: string, dropped: string[], upstream: UpstreamKind) => void;
  jevTimeoutMs?: number;
}): AccountPoolHub {
  const adapters: ReadonlyMap<PoolProvider, ProviderAdapter> = new Map([
    [
      "claude",
      createClaudeAdapter({
        refreshUrl: options.refreshUrl ?? DEFAULT_REFRESH_URL,
        usageUrl: options.usageUrl ?? DEFAULT_USAGE_URL,
        profileUrl: options.profileUrl ?? DEFAULT_PROFILE_URL,
        importCredentials: options.importClaudeCredentials,
      }),
    ],
    [
      "codex",
      createCodexAdapter({
        refreshUrl: options.codexRefreshUrl ?? DEFAULT_CODEX_REFRESH_URL,
        usageUrl: options.codexUsageUrl ?? DEFAULT_CODEX_USAGE_URL,
        importCredentials: options.importCodexCredentials,
      }),
    ],
  ]);
  return new AccountPoolHub({
    accounts: options.accounts,
    quotas: options.quotas,
    affinity: options.affinity,
    routes: options.routes,
    hubTokens: options.hubTokens,
    getSettings: options.getSettings,
    adapters,
    keyAdapters: new Map(
      [...adapters].map(([provider, base]) => [
        provider,
        createKeyAdapter(provider, base),
      ]),
    ),
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    usageRefreshIntervalMs:
      options.usageRefreshIntervalMs ?? DEFAULT_USAGE_REFRESH_INTERVAL_MS,
    drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    onAccountsChanged: options.onAccountsChanged ?? (() => {}),
    onUpstreamError: options.onUpstreamError ?? (() => {}),
    onRouteChanged: options.onRouteChanged ?? (() => {}),
    onDropped: options.onDropped ?? (() => {}),
    jevTimeoutMs: options.jevTimeoutMs ?? JEV_TIMEOUT_MS,
  });
}

/**
 * One chain entry's accounts, split into what one request body can serve. A
 * compatible key (one with a base URL) is its own group: it has its own vendor
 * and its own `<kind>:<label>` model map. The rest rotate as the Pooler did.
 */
function candidateGroups(accounts: readonly Account[]): Account[][] {
  const pooled = accounts.filter((account) => account.baseUrl === undefined);
  return [
    ...(pooled.length > 0 ? [pooled] : []),
    ...accounts
      .filter((account) => account.baseUrl !== undefined)
      .map((account) => [account]),
  ];
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

function requestModel(json: unknown): string | null {
  return typeof json === "object" &&
    json !== null &&
    "model" in json &&
    typeof json.model === "string"
    ? json.model
    : null;
}

/**
 * Drops the query token and, for FX, its own ChatGPT login headers (S2) before
 * anything reaches the upstream. The upstream adapter then sets its own
 * authorization and chatgpt-account-id; FX's originator is replaced here.
 */
async function withoutClientCredentials(
  request: Request,
  harness: Harness,
): Promise<Request> {
  const url = new URL(request.url);
  if (!url.searchParams.has(TOKEN_QUERY) && harness !== "acp-fx")
    return request;
  url.searchParams.delete(TOKEN_QUERY);
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("chatgpt-account-id");
  if (harness === "acp-fx") headers.set("originator", "bb");
  return new Request(url, {
    method: request.method,
    headers,
    signal: request.signal,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
  });
}

function readBearer(value: string | null): string | null {
  if (value === null) return null;
  return /^Bearer\s+(.+)$/iu.exec(value)?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timeout.unref();
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Pull-based stream over a generator; canceling it returns the generator. */
function streamFrom(
  chunks: AsyncGenerator<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

/** Wraps a compatible key's thinking and reasoning for its client (fitReplay unwraps). */
async function wrapKeyResponse(response: Response, up: string): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream"))
    return new Response(
      streamFrom(
        wrapKeySse(response.body as unknown as AsyncIterable<Uint8Array>, up),
      ),
      init,
    );
  if (!type.includes("json")) return response;
  const text = await response.text();
  const json = parseJson(new TextEncoder().encode(text));
  return new Response(wrapKeyOutput(json, up) ? JSON.stringify(json) : text, init);
}

/** The `response` of the terminal Responses event in a finished SSE body. */
async function completedResponse(
  body: ReadableStream<Uint8Array>,
): Promise<unknown> {
  const text = await new Response(body).text();
  for (const frame of text.replace(/\r\n?/gu, "\n").split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    try {
      const event: unknown = JSON.parse(data);
      if (
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        "response" in event &&
        (event.type === "response.completed" ||
          event.type === "response.failed" ||
          event.type === "response.incomplete")
      )
        return event.response;
    } catch {
      // Not a JSON data frame.
    }
  }
  return null;
}

/** An upstream error response, re-shaped as the client protocol's error body. */
async function translatedError(
  client: ProviderAdapter,
  upstream: Response,
  name: string,
): Promise<Response> {
  const text = (await upstream.text().catch(() => "")).slice(
    0,
    MAX_FAILURE_DETAIL_BYTES,
  );
  let message = text.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const error = "error" in parsed ? parsed.error : null;
      const detail =
        typeof error === "object" && error !== null && "message" in error
          ? error.message
          : "detail" in parsed
            ? parsed.detail
            : null;
      if (typeof detail === "string" && detail.length > 0) message = detail;
    }
  } catch {
    // Keep the raw text.
  }
  const retryAfter = upstream.headers.get("retry-after");
  return client.errorResponse(
    upstream.status,
    `${name}: ${message || `HTTP ${upstream.status}`}`,
    retryAfter === null ? {} : { "retry-after": retryAfter },
  );
}
