// Ported from the core Account Pooler (account-pool), MIT, Michael Yong 2026.
import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstreams/upstream-transport.js";
import path from "node:path";
import type {
  BbPluginApi,
  ExperimentalPluginProviderEnvEntry,
} from "@get-bb/plugin-sdk";
import { registerPoolCli } from "./cli.js";
import {
  ACCOUNT_POOL_BLOCKED_LABEL,
  ACCOUNT_POOL_BLOCKED_STATUS_MESSAGE,
  isAccountPoolRouting,
} from "./coexistence.js";
import { runGatewayDoctor, formatDoctorReport } from "./gateway-doctor.js";
import { importAccountPool } from "./import-pool.js";
import {
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  type AccountPoolConfigController,
} from "./contracts.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./upstreams/credentials.js";
import { createCodexWebSocketHandlers } from "./upstreams/codex-websocket.js";
import { createHub, TOKEN_QUERY } from "./hub.js";
import { PoolOperations } from "./operations.js";
import { accountPoolRpcContract, createRpcHandlers } from "./rpc.js";
import { createInferenceHandlers } from "./inference.js";
import { createThreadRuntimeStatusHandlers } from "./thread-runtime-status.js";
import { ClaudeOAuthLogin } from "./upstreams/oauth-login.js";
import { CodexDeviceLogin } from "./upstreams/codex-device-login.js";
import {
  MODEL_GATEWAY_ACCOUNTS_CHANGED,
  MODEL_GATEWAY_CONFIG_CHANGED,
  MODEL_GATEWAY_ROUTE_CHANGED,
} from "./realtime.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
  ThreadRouteStore,
} from "./upstreams/store.js";
import {
  assertLegalChains,
  expandChain,
  isLegalUpstream,
  upstreamKind,
  type Harness,
} from "./chain.js";

// Shown in `bb plugin list` and the plugin page. The banner clears on the next
// load, and adding an account does not reload the plugin, so the message says to.
export const NEEDS_ACCOUNT_MESSAGE =
  "No Claude or Codex account or API key is enabled. Add one with `bb gateway account add` or `bb gateway key add`, then run `bb plugin reload model-gateway`.";

export interface AccountPoolPluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  usageUrl?: string;
  usageRefreshIntervalMs?: number;
  drainTimeoutMs?: number;
  jevTimeoutMs?: number;
  disposeTimeoutMs?: number;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthProfileUrl?: string;
  codexAuthBaseUrl?: string;
  nativeClaudeCommand?: string;
}

const DISPOSE_INSPECTION_TIMEOUT_MS = 2_000;
const DISPOSE_INSPECTION_TIMEOUT = Symbol("dispose-inspection-timeout");

export function helloResponse(): Response {
  return new Response(null, { status: 200 });
}

export function createAccountPoolPlugin(
  options: AccountPoolPluginOptions = {},
) {
  return async function accountPoolPlugin(bb: BbPluginApi): Promise<void> {
    let currentSettings = accountPoolConfigSchema.parse(
      (await bb.storage.kv.get("config")) ?? {},
    );
    const config: AccountPoolConfigController = {
      get: () => currentSettings,
      set: async (input) => {
        const update = accountPoolConfigSetInputSchema.parse(input);
        const next = accountPoolConfigSchema.parse({
          ...currentSettings,
          ...update,
        });
        if (update.allowClaudeOAuthAcrossHarnesses === true && !currentSettings.allowClaudeOAuthAcrossHarnesses) {
          const defaults = accountPoolConfigSchema.parse({}).modelMap;
          next.modelMap = { ...next.modelMap };
          for (const kind of ["claude-oauth", "claude-key"])
            next.modelMap[kind] ??= defaults[kind]!;
        }
        assertLegalChains(next.chains, await accounts.list(), next.allowClaudeOAuthAcrossHarnesses);
        await bb.storage.kv.set("config", next);
        currentSettings = next;
        bb.realtime.publish(MODEL_GATEWAY_CONFIG_CHANGED, {});
        return next;
      },
    };
    const secretDir = path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "secrets",
      "accounts",
    );
    const accounts = new AccountStore(bb.storage.kv, secretDir);
    await accounts.initialize();
    const now = options.now ?? Date.now;
    const hubTokens = new HubTokenStore(secretDir, now);
    await hubTokens.initialize();
    const enrolledHosts = await bb.sdk.hosts.list();
    await hubTokens.prune(enrolledHosts.map((host) => host.id));
    const routing = new RoutingStore(bb.storage.kv, now);
    const db = bb.storage.database();
    bb.storage.migrate(db, QUOTA_MIGRATIONS);
    const quotas = new QuotaStore(db);
    const transport =
      options.fetch === undefined ? createUpstreamTransport() : null;
    const upstreamFetch = options.fetch ?? transport?.fetch;
    const routes = new ThreadRouteStore(db);
    const hub = createHub({
      accounts,
      quotas,
      affinity: new PoolAffinityStore(db),
      routes,
      hubTokens,
      getSettings: () => currentSettings,
      fetch: upstreamFetch,
      now,
      refreshUrl: options.refreshUrl,
      codexRefreshUrl: options.codexRefreshUrl,
      codexUsageUrl: options.codexUsageUrl,
      usageUrl: options.usageUrl,
      profileUrl: options.oauthProfileUrl,
      importClaudeCredentials: options.importCredentials,
      importCodexCredentials: options.importCodexCredentials,
      usageRefreshIntervalMs: options.usageRefreshIntervalMs,
      drainTimeoutMs: options.drainTimeoutMs,
      jevTimeoutMs: options.jevTimeoutMs,
      nativeClaudeCommand: options.nativeClaudeCommand,
      onUpstreamError: (provider, error) =>
        bb.log.warn(
          `Model Gateway ${provider} transport failed: ${transportErrorCode(error)}.`,
        ),
      onAccountsChanged: () =>
        bb.realtime.publish(MODEL_GATEWAY_ACCOUNTS_CHANGED, {}),
      onRouteChanged: (threadId) =>
        bb.realtime.publish(MODEL_GATEWAY_ROUTE_CHANGED, { threadId }),
      onDropped: (threadId, dropped, upstream) =>
        bb.log.warn(
          `Model Gateway left out ${dropped.join(", ")} for thread ${threadId}: no form on ${upstream}.`,
        ),
    });
    if (transport !== null) {
      bb.onDispose(async () => {
        await hub.stop();
        await transport.destroy();
      });
    }
    const operations = new PoolOperations(
      accounts,
      quotas,
      hub,
      hubTokens,
      routing,
      () => bb.sdk.hosts.list(),
      async (hostId) =>
        (await bb.sdk.system.providerStates({ hostId })).providers,
      now,
      () => bb.realtime.publish(MODEL_GATEWAY_ACCOUNTS_CHANGED, {}),
      (accountId) => hub.refreshUsage(accountId, true),
    );
    const login = new ClaudeOAuthLogin({
      fetch: upstreamFetch,
      now,
      authorizeUrl: options.oauthAuthorizeUrl,
      tokenUrl: options.oauthTokenUrl,
      profileUrl: options.oauthProfileUrl,
      addAccount: (authenticated) => operations.addOAuth(authenticated),
    });
    const codexLogin = new CodexDeviceLogin({
      fetch: upstreamFetch,
      now,
      authBaseUrl: options.codexAuthBaseUrl,
      addAccount: (authenticated) => operations.addCodexOAuth(authenticated),
    });
    // An enabled account must be legal for this harness and its request protocol.
    const chainUsable = async (harness: Harness) => {
      for (const account of expandChain(currentSettings.chains[harness], await accounts.list()).flat()) {
        if (!isLegalUpstream(upstreamKind(account), harness, harness === "claude-code" ? "/v1/messages" : "/v1/responses", currentSettings.allowClaudeOAuthAcrossHarnesses)) continue;
        try { await accounts.readSecret(account.id); return true; } catch { /* Health excludes missing credentials. */ }
      }
      return false;
    };
    if ((await accounts.list()).every((account) => !account.enabled)) {
      bb.status.needsConfiguration(NEEDS_ACCOUNT_MESSAGE);
    }
    bb.rpc.register(accountPoolRpcContract, {
      ...createRpcHandlers(operations, login, codexLogin, config, {
        accountPoolRouting: () => isAccountPoolRouting(bb),
        serverUrl: () => bb.server.loopbackBaseUrl,
      }),
      ...createInferenceHandlers(hub, now),
      ...createThreadRuntimeStatusHandlers(routes, now),
    });
    registerPoolCli(
      bb,
      operations,
      login,
      codexLogin,
      config,
      () => runGatewayDoctor(bb).then(formatDoctorReport),
      () =>
        importAccountPool({
          dataDir: bb.server.experimental_dataDir,
          accounts,
          Database: bb.storage.database()
            .constructor as typeof import("better-sqlite3"),
        }),
    );
    // BB drops failed env contributions. Keep transport configured even when no upstream can serve.
    bb.providers.experimental_contributeEnv("claude-code", async (context) => {
      if (await isAccountPoolRouting(bb)) return [];
      if (
        !(await operations.isRoutingEnabled("claude")) ||
        (await routing.isBypassed(context.threadId))
      ) {
        return [];
      }
      const token = await hubTokens.forThread({
        hostId: context.hostId,
        threadId: context.threadId,
        harness: "claude-code",
      });
      const hasResponsesFallback = expandChain(
        currentSettings.chains["claude-code"],
        await accounts.list(),
      ).some((entry) => entry.some((account) => account.provider === "codex"));
      await routing.recordRouted(context.threadId, context.hostId);
      return [
        {
          name: "ANTHROPIC_BASE_URL",
          value: {
            serverPath: "/api/v1/plugins/model-gateway/http",
          },
          reason: "Routed through the Model Gateway hub",
        },
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          value: token,
          reason: "Model Gateway hub token for this thread",
        },
        {
          name: "ENABLE_TOOL_SEARCH",
          value: "true",
          reason:
            "Claude Code turns tool search off behind a custom base URL; the hub forwards tool_reference blocks",
        },
        ...(hasResponsesFallback
          ? [{
              name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
              value: "160000",
              reason: "Keep Claude Code context within the Responses fallback window",
            }]
          : []),
      ];
    });
    bb.providers.experimental_contributeEnvHealth("claude-code", async () => {
      if (await isAccountPoolRouting(bb)) {
        return {
          label: ACCOUNT_POOL_BLOCKED_LABEL,
          statusMessage: ACCOUNT_POOL_BLOCKED_STATUS_MESSAGE,
        };
      }
      return (await operations.isRoutingEnabled("claude")) &&
        (await chainUsable("claude-code"))
        ? {
            label: (await hub.onFallback("claude-code"))
              ? "Gateway: on fallback"
              : "Gateway",
            statusMessage:
              "Credentials are provided by the Model Gateway hub.",
          }
        : null;
    });
    bb.providers.experimental_contributeEnv("codex", async (context) => {
      if (await isAccountPoolRouting(bb)) return [];
      if (
        !(await operations.isRoutingEnabled("codex")) ||
        (await routing.isBypassed(context.threadId))
      ) {
        return [];
      }
      const token = await hubTokens.forThread({
        hostId: context.hostId,
        threadId: context.threadId,
        harness: "codex",
      });
      return [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: {
            serverPath: "/api/v1/plugins/model-gateway/http/v1",
          },
          reason: "Routed through the Model Gateway hub",
        },
        {
          name: "CODEX_POOL_AUTH_TOKEN",
          value: token,
          reason: "Model Gateway hub token for this thread",
        },
      ];
    });
    bb.providers.experimental_contributeEnvHealth("codex", async () => {
      if (await isAccountPoolRouting(bb)) {
        return {
          label: ACCOUNT_POOL_BLOCKED_LABEL,
          statusMessage: ACCOUNT_POOL_BLOCKED_STATUS_MESSAGE,
        };
      }
      return (await operations.isRoutingEnabled("codex")) &&
        (await chainUsable("codex"))
        ? {
            label: (await hub.onFallback("codex"))
              ? "Gateway: on fallback"
              : "Gateway",
            statusMessage:
              "Credentials are provided by the Model Gateway hub.",
          }
        : null;
    });
    // ACP harnesses and Pi. The Pooler never routes these, so there is no
    // coexistence gate. omp and Pi also need `bb gateway setup omp|pi`.
    const http = "/api/v1/plugins/model-gateway/http";
    const acpEnv: Record<
      "acp-omp" | "acp-fx" | "acp-nanocodex" | "acp-prime-agent" | "pi",
      (token: string) => ExperimentalPluginProviderEnvEntry[]
    > = {
      "acp-prime-agent": (token) => acpEnv.pi(token),
      "acp-omp": (token) => [
        { name: "MODEL_GATEWAY_BASE_URL", value: { serverPath: `${http}/v1` }, reason: "Gateway endpoint for OMP's managed provider" },
        {
          name: "MODEL_GATEWAY_TOKEN",
          value: token,
          reason: "Model Gateway hub token for this thread (omp models.yml apiKey)",
        },
      ],
      "acp-fx": (token) => [
        {
          name: "FX_E2E_OPENAI_CODEX_RESPONSES_URL",
          value: { serverPath: `${http}/v1/responses?${TOKEN_QUERY}=${token}` },
          reason: "Routed through the Model Gateway hub; the URL carries this thread's hub token",
        },
        {
          name: "FX_E2E_OPENAI_CODEX_MODELS_URL",
          value: { serverPath: `${http}/v1/models?${TOKEN_QUERY}=${token}` },
          reason: "Routed through the Model Gateway hub; the URL carries this thread's hub token",
        },
      ],
      "acp-nanocodex": (token) => [
        {
          name: "NANOCODEX_API_BASE_URL",
          value: { serverPath: `${http}/v1` },
          reason: "Routed through the Model Gateway hub",
        },
        {
          name: "MODEL_GATEWAY_TOKEN",
          value: token,
          reason: "Model Gateway hub token for this thread",
        },
      ],
      // Pi ignores base-URL env vars and models.json cannot read env in baseUrl,
      // so the model-gateway Pi extension reads these two (WP4.3).
      pi: (token) => [
        {
          name: "MODEL_GATEWAY_BASE_URL",
          value: { serverPath: `${http}/v1` },
          reason: "Routed through the Model Gateway hub (read by the model-gateway Pi extension)",
        },
        {
          name: "MODEL_GATEWAY_TOKEN",
          value: token,
          reason: "Model Gateway hub token for this thread",
        },
      ],
    };
    for (const [harness, entries] of Object.entries(acpEnv) as Array<
      [keyof typeof acpEnv, (token: string) => ExperimentalPluginProviderEnvEntry[]]
    >) {
      const routed = async () =>
        (await operations.isRoutingEnabled(harness)) &&
        (await chainUsable(harness));
      bb.providers.experimental_contributeEnv(harness, async (context) => {
        if (!(await operations.isRoutingEnabled(harness)) || await routing.isBypassed(context.threadId)) return [];
        return [{ name: "MODEL_GATEWAY_REQUIRED", value: "1", reason: "BB-managed inference must use Model Gateway" }, ...entries(
          await hubTokens.forThread({
            hostId: context.hostId,
            threadId: context.threadId,
            harness,
          }),
        )];
      });
      bb.providers.experimental_contributeEnvHealth(harness, async () =>
        (await routed())
          ? {
              label: (await hub.onFallback(harness))
                ? "Gateway: on fallback"
                : "Gateway",
              statusMessage: "Model Gateway is configured. The last observed request shows the active route.",
            }
          : null,
      );
    }
    // Exact provider ids only; removed registrations cannot be unregistered.
    const registeredPi = new Set<string>();
    let activePi = new Set<string>();
    let scan = Promise.resolve();
    let disposed = false;
    const rescanPi = () => {
      scan = scan.then(async () => {
        if (disposed) return;
        const catalog = await bb.sdk.providers.catalog();
        if (disposed) return;
        activePi = new Set(catalog
          .filter((provider) => provider.info?.family === "agents" &&
            (provider.id === "hempi" || provider.id === "agents" || /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(provider.id)))
          .map((provider) => provider.id));
        for (const id of activePi) {
          if (registeredPi.has(id)) continue;
          bb.providers.experimental_contributeEnv(id, async (context) => {
            if (!activePi.has(id) || !(await operations.isRoutingEnabled("pi")) || await routing.isBypassed(context.threadId)) return [];
            return [{ name: "MODEL_GATEWAY_REQUIRED", value: "1", reason: "BB-managed inference must use Model Gateway" }, ...acpEnv.pi(await hubTokens.forThread({
              hostId: context.hostId, threadId: context.threadId, harness: "pi",
            }))];
          });
          registeredPi.add(id);
        }
      }).catch(() => {
        activePi.clear();
        bb.log.warn("Model Gateway could not rescan Pi provider registrations.");
      });
      return scan;
    };
    bb.background.service("pi-providers", {
      start: async (signal) => {
        const unsubscribe = bb.sdk.subscribe({
          event: "system:changed",
          callback: (event) => {
            if (event.changes.includes("provider-registrations-changed")) void rescanPi();
          },
        });
        try {
          await rescanPi();
          if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        } finally { unsubscribe(); }
      },
    });
    bb.onDispose(() => { disposed = true; activePi.clear(); });
    // Provider discovery can wait for plugin loading; run it only in the service.
    bb.onDispose(async () => {
      codexLogin.dispose();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const inspection = inspectDisableState(bb, operations);
        const timeout = new Promise<typeof DISPOSE_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(DISPOSE_INSPECTION_TIMEOUT),
              options.disposeTimeoutMs ?? DISPOSE_INSPECTION_TIMEOUT_MS,
            );
            timer.unref();
          },
        );
        const result = await Promise.race([inspection, timeout]);
        if (result === DISPOSE_INSPECTION_TIMEOUT) {
          bb.log.debug("Model Gateway disable inspection timed out.");
          return;
        }
        if (result !== null) bb.log.warn(result);
      } catch (error) {
        bb.log.debug(
          `Model Gateway disable inspection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });
    bb.http.route(
      "POST",
      "/v1/messages",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    bb.http.route(
      "POST",
      "/v1/messages/count_tokens",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    bb.http.route(
      "POST",
      "/v1/responses",
      (context) => hub.handle(context.req.raw, "codex"),
      { auth: "none" },
    );
    bb.http.route(
      "POST",
      "/v1/alpha/search",
      (context) => hub.handle(context.req.raw, "codex"),
      { auth: "none" },
    );
    bb.http.route(
      "GET",
      "/v1/models",
      (context) => hub.handle(context.req.raw, "codex"),
      { auth: "none" },
    );
    bb.http.experimental_websocket(
      "/v1/responses",
      (context) => createCodexWebSocketHandlers(context, hub, bb.log),
      { auth: "none" },
    );
    bb.http.route("HEAD", "/api/hello", () => helloResponse(), {
      auth: "none",
    });
    bb.background.service("hub", {
      start: (signal) => hub.start(signal),
    });
  };
}

async function inspectDisableState(
  bb: BbPluginApi,
  operations: PoolOperations,
): Promise<string | null> {
  const installed = await bb.sdk.plugins.list();
  const disabled =
    installed.plugins.find((plugin) => plugin.id === bb.pluginId)?.enabled ===
    false;
  if (!disabled) return null;
  const warnings = await operations.routedThreadsWithoutLocalLogin();
  if (warnings.length === 0) return null;
  return `Model Gateway disabled with ${warnings.length} recently routed thread${warnings.length === 1 ? "" : "s"} on machines without a local Claude login. Run bb gateway status before disabling to inspect them.`;
}

export default createAccountPoolPlugin();
