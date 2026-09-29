// Ported from the core Account Pooler (account-pool), MIT, Michael Yong 2026.
import type {
  Account,
  AccountSummary,
  HubTokenSummary,
  PoolProvider,
  PoolStatus,
  RoutedThreadStatus,
  RoutingTarget,
} from "./contracts.js";
import type {
  AccountAddInput,
  AccountPoolConfig,
  AccountPoolConfigController,
  KeyAddInput,
} from "./contracts.js";
import {
  chainsSchema,
  modelMapKeySchema,
  upstreamKind,
  type Harness,
} from "./chain.js";
import type { AccountPoolHub, ThreadRouteStatus } from "./hub.js";
import type {
  AccountStore,
  HubTokenStore,
  QuotaStore,
  RoutingStore,
} from "./upstreams/store.js";
import type { ClaudeOAuthAccount } from "./upstreams/oauth-login.js";
import type { CodexDeviceAccount } from "./upstreams/codex-device-login.js";

interface PoolHost {
  id: string;
  name: string;
}

interface PoolProviderState {
  providerId: string;
  status: string;
  planLabel: string | null;
}

const ROUTED_WINDOW_MS = 24 * 60 * 60 * 1_000;

// Config edits shared by the CLI and the settings pane. `config.set` runs the
// chain legal guard, so an illegal chain never saves from either.

/** `bb gateway chain set`: replace one harness's failover chain. */
export function setChain(
  config: AccountPoolConfigController,
  harness: Harness,
  entries: readonly string[],
): Promise<AccountPoolConfig> {
  const current = config.get().chains;
  return config.set({
    chains: chainsSchema.parse({ ...current, [harness]: entries }),
  });
}

/** `bb gateway model-map set`: map one pattern; a null model removes the row. */
export function setModelMapEntry(
  config: AccountPoolConfigController,
  key: string,
  pattern: string,
  model: string | null,
): Promise<AccountPoolConfig> {
  const kind = modelMapKeySchema.parse(key);
  const current = config.get().modelMap;
  const { [pattern]: _removed, ...kept } = current[kind] ?? {};
  const rows = model === null ? kept : { ...current[kind], [pattern]: model };
  const { [kind]: _emptied, ...others } = current;
  return config.set({
    modelMap:
      Object.keys(rows).length === 0 ? others : { ...current, [kind]: rows },
  });
}

export const JEV_KEY_MISSING =
  "Jev needs an OpenRouter key: printf '%s\\n' \"$KEY\" | bb gateway key add responses-compatible-key --label openrouter --base-url https://openrouter.ai/api/v1 --key-stdin, then bb gateway auto <harness> --key openrouter.";

/** `bb gateway auto`: turn Jev on or off for a harness, or change its key or model. */
export async function setAuto(
  config: AccountPoolConfigController,
  accounts: readonly Account[],
  change: { harness?: Harness; off?: boolean; key?: string; model?: string },
): Promise<AccountPoolConfig> {
  const current = config.get().auto;
  const key = change.key ?? current.key;
  const harnesses =
    change.harness === undefined
      ? current.harnesses
      : change.off === true
        ? current.harnesses.filter((name) => name !== change.harness)
        : [...new Set([...current.harnesses, change.harness])];
  if (harnesses.length > 0 && key === null) throw new Error(JEV_KEY_MISSING);
  if (
    key !== null &&
    !accounts.some(
      (account) =>
        upstreamKind(account) === "responses-compatible-key" &&
        account.label === key,
    )
  )
    throw new Error(`No responses-compatible-key is labelled ${key}.`);
  return config.set({
    auto: { harnesses, key, model: change.model ?? current.model },
  });
}

export class PoolOperations {
  constructor(
    private readonly accounts: AccountStore,
    private readonly quotas: QuotaStore,
    private readonly hub: AccountPoolHub,
    private readonly hubTokens: HubTokenStore,
    private readonly routing: RoutingStore,
    private readonly listHosts: () => Promise<PoolHost[]>,
    private readonly providerStates: (
      hostId: string,
    ) => Promise<PoolProviderState[]>,
    private readonly now: () => number = Date.now,
    private readonly onAccountsChanged: () => void = () => {},
    private readonly onAccountEnabled: (
      accountId: string,
    ) => Promise<void> = async () => {},
  ) {}

  async add(input: AccountAddInput): Promise<Account> {
    if (input.source.kind === "api-key") {
      if (input.provider !== "claude") {
        throw new Error("Codex accounts can only be added with --import.");
      }
      const account = await this.accounts.add(
        {
          provider: input.provider,
          kind: "api-key",
          label: input.label ?? "Claude API key",
          email: null,
          accountUuid: null,
          subscriptionType: null,
          rateLimitTier: null,
          enabled: true,
          priority: input.priority,
        },
        { kind: "api-key", apiKey: input.source.apiKey },
      );
      this.onAccountsChanged();
      await this.onAccountEnabled(account.id);
      return account;
    }
    const imported = await this.hub.importAccount(input.provider);
    const account = await this.accounts.add(
      {
        provider: input.provider,
        kind: "oauth",
        label: input.label ?? imported.label,
        email: imported.email,
        accountUuid: imported.accountUuid ?? null,
        ...(imported.codexAccountId === undefined
          ? {}
          : { codexAccountId: imported.codexAccountId }),
        subscriptionType: imported.subscriptionType,
        rateLimitTier: imported.rateLimitTier,
        enabled: true,
        priority: input.priority,
      },
      imported.secret,
    );
    this.onAccountsChanged();
    await this.onAccountEnabled(account.id);
    return account;
  }

  /** P4: an API key. Labels are unique per kind: chains and model maps name them. */
  async addKey(input: KeyAddInput): Promise<Account> {
    if (
      (await this.accounts.list()).some(
        (account) =>
          upstreamKind(account) === input.kind && account.label === input.label,
      )
    )
      throw new Error(`A ${input.kind} labelled ${input.label} already exists.`);
    const account = await this.accounts.add(
      {
        provider: input.kind === "responses-compatible-key" ? "codex" : "claude",
        kind: "api-key",
        label: input.label,
        email: null,
        accountUuid: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: input.priority,
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      },
      { kind: "api-key", apiKey: input.apiKey },
    );
    this.onAccountsChanged();
    return account;
  }

  async addOAuth(authenticated: ClaudeOAuthAccount): Promise<Account> {
    const account = await this.accounts.add(
      {
        provider: "claude",
        kind: "oauth",
        label: authenticated.label,
        email: authenticated.email,
        accountUuid: authenticated.accountUuid,
        subscriptionType: authenticated.subscriptionType,
        rateLimitTier: authenticated.rateLimitTier,
        enabled: true,
        priority: 100,
      },
      {
        kind: "oauth",
        accessToken: authenticated.accessToken,
        refreshToken: authenticated.refreshToken,
        expiresAt: authenticated.expiresAt,
      },
    );
    this.onAccountsChanged();
    await this.onAccountEnabled(account.id);
    return account;
  }

  async addCodexOAuth(
    authenticated: CodexDeviceAccount,
  ): Promise<AccountSummary> {
    const account = await this.accounts.add(
      {
        provider: "codex",
        kind: "oauth",
        label: authenticated.label,
        email: authenticated.email,
        accountUuid: null,
        codexAccountId: authenticated.accountId,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
      },
      {
        kind: "oauth",
        accessToken: authenticated.accessToken,
        refreshToken: authenticated.refreshToken,
        idToken: authenticated.idToken,
        expiresAt: authenticated.expiresAt,
      },
    );
    this.onAccountsChanged();
    await this.onAccountEnabled(account.id);
    const summary = (await this.list()).find((item) => item.id === account.id);
    if (summary === undefined) {
      throw new Error("Added Codex account could not be read back.");
    }
    return summary;
  }

  async list(): Promise<AccountSummary[]> {
    return (await this.status()).accounts;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.accounts.remove(id);
    if (removed) {
      this.quotas.remove(id);
      this.onAccountsChanged();
    }
    return removed;
  }

  async enable(id: string): Promise<Account | null> {
    const account = await this.accounts.setEnabled(id, true);
    if (account === null) return null;
    const quota = this.quotas.get(id);
    this.quotas.put({ ...quota, error: null, heldUntil: null });
    this.onAccountsChanged();
    await this.onAccountEnabled(account.id);
    return account;
  }

  async disable(id: string): Promise<Account | null> {
    const account = await this.accounts.setEnabled(id, false);
    if (account !== null) this.onAccountsChanged();
    return account;
  }

  async setPriority(id: string, priority: number): Promise<Account | null> {
    const account = await this.accounts.setPriority(id, priority);
    if (account !== null) this.onAccountsChanged();
    return account;
  }

  async reorder(provider: PoolProvider, accountIds: string[]): Promise<void> {
    await this.accounts.reorder(provider, accountIds);
    this.onAccountsChanged();
  }

  async refreshUsage(id: string): Promise<AccountSummary | null> {
    if ((await this.accounts.get(id)) === null) return null;
    await this.hub.refreshUsage(id, true);
    this.onAccountsChanged();
    return (
      (await this.status()).accounts.find((account) => account.id === id) ??
      null
    );
  }

  async setRouting(provider: RoutingTarget, enabled: boolean): Promise<void> {
    await this.routing.setProviderEnabled(provider, enabled);
    this.onAccountsChanged();
  }

  isRoutingEnabled(provider: RoutingTarget): Promise<boolean> {
    return this.routing.isProviderEnabled(provider);
  }

  async status(): Promise<PoolStatus> {
    const hosts = await this.listHosts();
    await this.hubTokens.prune(hosts.map((host) => host.id));
    const [status, routedThreadsWithoutLocalLogin] = await Promise.all([
      this.hub.status(),
      this.routedThreadsWithoutLocalLogin(),
    ]);
    const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
    const [claude, codex] = await Promise.all([
      this.routing.isProviderEnabled("claude"),
      this.routing.isProviderEnabled("codex"),
    ]);
    return {
      ...status,
      hosts: status.hosts.map((token) => ({
        ...token,
        hostName: hostNames.get(token.hostId) ?? null,
      })),
      accounts: status.accounts.map((account) => ({
        ...account,
        lastUsedHostName:
          account.lastUsedHostId === null
            ? null
            : (hostNames.get(account.lastUsedHostId) ?? null),
      })),
      routing: { claude, codex },
      routedThreadsWithoutLocalLogin,
    };
  }

  async rotateToken(machine: string): Promise<HubTokenSummary> {
    const hosts = await this.listHosts();
    const matches = hosts.filter(
      (host) => host.id === machine || host.name === machine,
    );
    if (matches.length === 0)
      throw new Error(`Machine ${machine} does not exist.`);
    if (matches.length > 1)
      throw new Error(`Machine name ${machine} matches more than one host.`);
    const host = matches[0];
    if (host === undefined)
      throw new Error(`Machine ${machine} does not exist.`);
    const token = await this.hubTokens.rotate(host.id);
    return { ...token, hostName: host.name };
  }

  /** Test hook: `bb gateway account hold`. Null `until` clears the hold. */
  async holdAccount(id: string, until: number | null): Promise<Account | null> {
    const account = await this.accounts.get(id);
    if (account === null) return null;
    this.hub.hold(id, until);
    this.onAccountsChanged();
    return account;
  }

  threadStatus(threadId: string): Promise<ThreadRouteStatus | null> {
    return this.hub.threadStatus(threadId);
  }

  /** Recently routed threads bound past chain entry 0 or on a Jev pick. */
  async notableRoutes(): Promise<ThreadRouteStatus[]> {
    return (await this.hub.recentRoutes()).filter(
      (route) => route.entryIndex > 0 || route.autoModel !== null,
    );
  }

  /** Accounts the router skips until a time: test-hook holds, rate limits, key credit. */
  holds(): Promise<Array<{ account: Account; until: number }>> {
    return this.hub.holds();
  }

  async setBypass(
    threadId: string,
    bypassed: boolean,
  ): Promise<{
    threadId: string;
    bypassed: boolean;
  }> {
    await this.routing.setBypassed(threadId, bypassed);
    return { threadId, bypassed };
  }

  async hasUsableEnabledAccount(provider?: PoolProvider): Promise<boolean> {
    for (const account of await this.accounts.list()) {
      if (
        !account.enabled ||
        (provider !== undefined && account.provider !== provider)
      )
        continue;
      try {
        await this.accounts.readSecret(account.id);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async routedThreadsWithoutLocalLogin(): Promise<RoutedThreadStatus[]> {
    const routed = await this.routing.listRoutedSince(
      this.now() - ROUTED_WINDOW_MS,
    );
    const [hosts, statesByHost] = await Promise.all([
      this.listHosts(),
      Promise.all(
        [...new Set(routed.map((entry) => entry.hostId))].map(
          async (hostId) => ({
            hostId,
            states: await this.providerStates(hostId).catch(() => []),
          }),
        ),
      ),
    ]);
    const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
    const localStateByHost = new Map(
      statesByHost.map(({ hostId, states }) => [
        hostId,
        states.find((state) => state.providerId === "claude-code") ?? null,
      ]),
    );
    return routed.flatMap((entry) => {
      const state = localStateByHost.get(entry.hostId);
      const status =
        state?.status === "ready" && state.planLabel === "Gateway"
          ? "proxied"
          : state?.status;
      if (
        status !== "unauthenticated" &&
        status !== "expired" &&
        status !== "proxied"
      )
        return [];
      return [
        {
          ...entry,
          hostName: hostNames.get(entry.hostId) ?? null,
          localClaudeStatus: status,
        },
      ];
    });
  }
}
