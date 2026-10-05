// Ported from the core Account Pooler (account-pool), MIT, Michael Yong 2026.
import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
  accountAddInputSchema,
  accountIdInputSchema,
  accountPriorityInputSchema,
  accountReorderInputSchema,
  accountPoolConfigSetInputSchema,
  bypassInputSchema,
  codexLoginPollInputSchema,
  keyAddInputSchema,
  loginCompleteInputSchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  type AccountPoolConfig,
  type AccountPoolConfigController,
  type AccountPoolConfigSetInput,
  type AccountSummary,
  type FamilyQuota,
  type LimitWindow,
  type ModelFamily,
  type PoolStatus,
} from "./contracts.js";
import {
  setAuto,
  setChain,
  setModelMapEntry,
  type PoolOperations,
} from "./operations.js";
import type { ClaudeOAuthLogin } from "./upstreams/oauth-login.js";
import type { CodexDeviceLogin } from "./upstreams/codex-device-login.js";
import type { ImportPoolResult } from "./import-pool.js";
import {
  expandChain,
  type AutoSettings,
  harnessSchema,
  HARNESSES,
  upstreamKind,
  type ModelMap,
} from "./chain.js";
import type { ThreadRouteStatus } from "./hub.js";
import {
  FX_SETUP,
  NANOCODEX_SETUP,
  gatewayBaseUrl,
  ompSnippet,
  piExtension,
  writeOmpProvider,
  writePiExtension,
} from "./setup.js";

interface ParsedFlags {
  booleans: Set<string>;
  values: Map<string, string>;
}

const HELP = [
  "Usage:",
  "  bb gateway account add --provider claude --import [--label <text>] [--priority <n>]",
  "  bb gateway account add --provider codex --import [--label <text>] [--priority <n>]",
  "  bb gateway account add --provider claude --login",
  "  bb gateway account add --provider codex --login",
  "  bb gateway account login-poll --session <id>",
  "  printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb gateway account login-complete --session <id> --code-stdin",
  "  bb gateway account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]",
  "  bb gateway account add --provider claude --api-key <key> [--label <text>] [--priority <n>]  Unsafe: exposes the key in process arguments.",
  "  printf '%s\\n' \"$KEY\" | bb gateway key add <claude-key|anthropic-compatible-key|responses-compatible-key> --label <label> [--base-url <url>] [--priority <n>] --key-stdin",
  "  bb gateway account list [--json]",
  "  bb gateway account remove <id>",
  "  bb gateway account enable <id>",
  "  bb gateway account disable <id>",
  "  bb gateway account priority <id> <n>",
  "  bb gateway account reorder <claude|codex> <id>...",
  "  bb gateway status [--json]",
  "  bb gateway status --thread <id> [--json]",
  "  bb gateway chain show [--json]",
  "  bb gateway chain set <harness> <entry>...   entry: <kind>:*, <kind>:<label>, or an account id",
  "      kinds: claude-oauth, claude-key, chatgpt-oauth, anthropic-compatible-key, responses-compatible-key",
  "  bb gateway model-map show [--json]",
  "  bb gateway model-map set <kind>[:<label>] <pattern> <model>",
  "  bb gateway auto [show]",
  "  bb gateway auto <harness> [--key <label>] [--model <id>] [--off]   Jev picks the model per user turn",
  "  bb gateway account hold <id> --until <+1h|ISO time> | --clear   Test hook: treat the account as exhausted",
  "  bb gateway routing <claude|codex|acp-omp|acp-fx|acp-nanocodex|pi> [--off]",
  "  bb gateway config",
  "  bb gateway config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold> <value>",
  "  bb gateway token rotate --machine <id-or-name>",
  "  bb gateway bypass <thread-id> [--off]",
  "  bb gateway doctor",
  "  bb gateway import-pool",
  "  bb gateway setup omp [--print] [--server-url <url>]   Writes the gateway provider into ~/.omp/agent/models.yml on the BB server machine",
  "  bb gateway setup fx   Prints optional standalone fx-acp setup",
  "  bb gateway setup nanocodex   Prints optional standalone nanocodex-acp setup",
  "  bb gateway setup pi [--print]   Writes the gateway provider extension into ~/.pi/agent/extensions on the BB server machine",
  "",
  "API keys bill per token. Claude OAuth (Max) accounts serve only Claude Code.",
  "Accounts run sequentially by priority, then order added. The current fallback stays active until unavailable.",
  "Reorder includes every account for the provider and changes the next failover sequence; existing conversations stay pinned.",
].join("\n");

function parseFlags(
  argv: readonly string[],
  allowedBooleans: readonly string[],
  allowedValues: readonly string[],
): ParsedFlags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) {
      throw new Error(`Unexpected argument ${JSON.stringify(arg)}.`);
    }
    const name = arg.slice(2);
    if (booleans.has(name) || values.has(name)) {
      throw new Error(`Duplicate flag --${name}.`);
    }
    if (allowedBooleans.includes(name)) {
      booleans.add(name);
      continue;
    }
    if (!allowedValues.includes(name))
      throw new Error(`Unknown flag --${name}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    values.set(name, value);
    index += 1;
  }
  return { booleans, values };
}

function formatReset(value: number | null): string {
  return value === null ? "-" : new Date(value).toISOString();
}

function formatUtilization(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

const MODEL_FAMILIES: ModelFamily[] = [
  "fable",
  "sonnet",
  "opus",
  "haiku",
  "other",
];

function familyLabel(family: ModelFamily): string {
  return family[0]?.toUpperCase() + family.slice(1);
}

function formatWindowLabel(window: LimitWindow): string {
  if (window.windowMinutes === null) return window.slot;
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}d`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}h`;
  return `${window.windowMinutes}m`;
}

function formatLimitWindows(windows: readonly LimitWindow[]): string {
  if (windows.length === 0) return "-";
  return windows
    .map(
      (window) =>
        `${formatWindowLabel(window)}=${formatUtilization(window.utilization)} ${formatReset(window.resetAt)}`,
    )
    .join("; ");
}

function formatFamilyQuota(quota: FamilyQuota | null): string {
  if (quota === null) return "-";
  return [
    formatUtilization(quota.utilization),
    quota.status ?? "-",
    formatReset(quota.resetAt),
    quota.source,
  ].join(" ");
}

function formatAccounts(accounts: readonly AccountSummary[]): string {
  if (accounts.length === 0) return "No accounts configured.";
  const families = MODEL_FAMILIES.filter((family) =>
    accounts.some((account) => account.familyWeekly[family] !== null),
  );
  return [
    [
      "ID",
      "Label",
      "Provider",
      "Kind",
      "Upstream",
      "Enabled",
      "Priority",
      "5h",
      "5h reset",
      "7d",
      "7d reset",
      "Windows",
      ...families.map(familyLabel),
      "Status",
    ].join("\t"),
    ...accounts.map((account) =>
      [
        account.id,
        account.label,
        account.provider,
        account.kind,
        account.baseUrl === undefined
          ? upstreamKind(account)
          : `${upstreamKind(account)} ${account.baseUrl}`,
        String(account.enabled),
        String(account.priority),
        formatUtilization(account.fiveHourUtilization),
        formatReset(account.fiveHourResetAt),
        formatUtilization(account.sevenDayUtilization),
        formatReset(account.sevenDayResetAt),
        formatLimitWindows(account.limitWindows),
        ...families.map((family) =>
          formatFamilyQuota(account.familyWeekly[family]),
        ),
        account.status,
      ].join("\t"),
    ),
  ].join("\n");
}

function formatStatus(status: PoolStatus): string {
  return [
    `Route: ${status.route}`,
    `Accepting: ${status.accepting}`,
    `Enabled accounts: ${status.enabledAccountCount}`,
    `In flight: ${status.inFlight}`,
    "",
    "Machine tokens:",
    ...(status.hosts.length === 0
      ? ["None minted."]
      : status.hosts.map(
          (host) =>
            `${host.hostName ?? host.hostId}\t${new Date(host.mintedAt).toISOString()}\t${host.lastUsedAt === null ? "never" : new Date(host.lastUsedAt).toISOString()}`,
        )),
    "",
    "Recently routed threads without a local Claude login:",
    ...(status.routedThreadsWithoutLocalLogin.length === 0
      ? ["None."]
      : status.routedThreadsWithoutLocalLogin.map(
          (thread) =>
            `${thread.threadId}\t${thread.hostName ?? thread.hostId}\t${thread.localClaudeStatus}`,
        )),
    "",
    formatAccounts(status.accounts),
  ].join("\n");
}

const JEV_PRIVACY =
  "Jev (OpenRouter) sees only the truncated last user message and the candidate model names.";

function formatAuto(auto: AutoSettings): string {
  return [
    `Auto (Jev): ${auto.harnesses.length === 0 ? "off" : auto.harnesses.join(", ")}`,
    `Jev key: ${auto.key === null ? "none" : `responses-compatible-key:${auto.key}`}`,
    `Jev model: ${auto.model}`,
    JEV_PRIVACY,
  ].join("\n");
}

function formatConfig(config: AccountPoolConfig): string {
  return [
    `anthropicUpstreamBaseUrl: ${config.anthropicUpstreamBaseUrl}`,
    `codexUpstreamBaseUrl: ${config.codexUpstreamBaseUrl}`,
    `switchThreshold: ${config.switchThreshold}`,
  ].join("\n");
}

function parseConfigUpdate(
  key: string | undefined,
  value: string | undefined,
): AccountPoolConfigSetInput {
  if (value === undefined) throw new Error(HELP);
  if (key === "anthropicUpstreamBaseUrl") {
    return accountPoolConfigSetInputSchema.parse({
      anthropicUpstreamBaseUrl: value,
    });
  }
  if (key === "codexUpstreamBaseUrl") {
    return accountPoolConfigSetInputSchema.parse({
      codexUpstreamBaseUrl: value,
    });
  }
  if (key === "switchThreshold") {
    return accountPoolConfigSetInputSchema.parse({
      switchThreshold: Number(value),
    });
  }
  throw new Error(
    "Config key must be anthropicUpstreamBaseUrl, codexUpstreamBaseUrl, or switchThreshold.",
  );
}

// `+90s`, `+30m`, `+1h`, `+2d`, epoch milliseconds, or any Date.parse input.
function parseUntil(value: string, now: number): number {
  const relative = /^\+(\d+)([smhd])$/u.exec(value);
  if (relative !== null) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      relative[2] as "s" | "m" | "h" | "d"
    ];
    return now + Number(relative[1]) * unit;
  }
  const parsed = /^\d+$/u.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error("--until must be +<n><s|m|h|d>, epoch ms, or an ISO time.");
  return parsed;
}

function formatChains(
  chains: AccountPoolConfig["chains"],
  accounts: readonly AccountSummary[],
): string {
  return HARNESSES.map((harness) => {
    const expanded = expandChain(chains[harness], accounts);
    return [
      harness,
      ...chains[harness].map((entry, index) => {
        const labels = (expanded[index] ?? []).map((account) => account.label);
        return `  ${index}  ${entry}\t${labels.length === 0 ? "-" : labels.join(", ")}`;
      }),
    ].join("\n");
  }).join("\n");
}

function formatModelMap(modelMap: ModelMap): string {
  const rows = Object.entries(modelMap).flatMap(([kind, patterns]) =>
    Object.entries(patterns ?? {}).map(
      ([pattern, model]) => `${kind}\t${pattern}\t${model}`,
    ),
  );
  return rows.length === 0 ? "No model mappings." : rows.join("\n");
}

function formatThreadStatus(route: ThreadRouteStatus): string {
  return [
    `Thread: ${route.threadId}`,
    `Harness: ${route.harness}`,
    `Upstream: ${route.upstreamLabel ?? route.upstreamId} (${route.upstreamKind ?? "removed"})`,
    `Model: ${route.model ?? "unknown"}`,
    ...(route.autoReason === null
      ? []
      : [`Auto: ${route.autoModel === null ? "client model" : `auto → ${route.autoModel}`} (${route.autoReason})`]),
    `Chain entry: ${route.entryIndex < 0 ? "not in chain" : `${route.entryIndex} ${route.entry}`}${route.entryIndex > 0 ? " (fallback)" : ""}`,
    `Reason: ${route.reason}`,
    ...(route.fallbackCause === null
      ? []
      : [
          `Fallback cause: ${route.fallbackCause.upstreamLabel} · ${route.fallbackCause.category} · HTTP ${route.fallbackCause.status} · ${route.fallbackCause.message}`,
          `Fallback at: ${new Date(route.fallbackCause.at).toISOString()}`,
        ]),
    `Bound at: ${new Date(route.boundAt).toISOString()}`,
    `Sticky until: ${formatReset(route.stickyUntil)}`,
    `Last used: ${new Date(route.usedAt).toISOString()}`,
  ].join("\n");
}

function json(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function registerPoolCli(
  bb: Pick<BbPluginApi, "cli" | "server">,
  operations: PoolOperations,
  login: ClaudeOAuthLogin,
  codexLogin: CodexDeviceLogin,
  config: AccountPoolConfigController,
  runDoctor: () => Promise<string>,
  runImportPool: () => Promise<ImportPoolResult>,
): void {
  bb.cli.register({
    name: "gateway",
    summary:
      "Manage Claude and Codex accounts and inspect the Model Gateway hub",
    commands: [
      {
        name: "account-add",
        summary:
          "Sign in to Claude or Codex, import credentials, or add an Anthropic API key",
        usage:
          "bb gateway account add --provider <claude|codex> --login\nbb gateway account add --provider <claude|codex> --import [--label <text>] [--priority <n>]\nbb gateway account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]\nUnsafe compatibility form: bb gateway account add --provider claude --api-key <key> [--label <text>] [--priority <n>]",
      },
      {
        name: "key-add",
        summary:
          "Add an API-key upstream (Anthropic, an Anthropic-compatible vendor, or a Responses-compatible vendor); reads the key from stdin",
        usage:
          "printf '%s\\n' \"$KEY\" | bb gateway key add <claude-key|anthropic-compatible-key|responses-compatible-key> --label <label> [--base-url <url>] [--priority <n>] --key-stdin",
      },
      {
        name: "account-login-poll",
        summary: "Wait for a Codex device-code login to complete",
        usage: "bb gateway account login-poll --session <id>",
      },
      {
        name: "account-login-complete",
        summary: "Complete a Claude browser login with its manual code",
        usage:
          "printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb gateway account login-complete --session <id> --code-stdin",
      },
      {
        name: "account-list",
        summary: "List pool accounts and observed quota",
        usage: "bb gateway account list [--json]",
      },
      {
        name: "account-remove",
        summary: "Remove an account and its secret token file",
        usage: "bb gateway account remove <id>",
      },
      {
        name: "account-enable",
        summary: "Enable an account",
        usage: "bb gateway account enable <id>",
      },
      {
        name: "account-disable",
        summary: "Disable an account",
        usage: "bb gateway account disable <id>",
      },
      {
        name: "account-priority",
        summary: "Set an account's position in the failover priority order",
        usage: "bb gateway account priority <id> <n>",
      },
      {
        name: "account-reorder",
        summary: "Set the complete failover order for one provider",
        usage: "bb gateway account reorder <claude|codex> <id>...",
      },
      {
        name: "status",
        summary: "Show hub, machine token, routing, and account status, or one thread's route",
        usage: "bb gateway status [--thread <id>] [--json]",
      },
      {
        name: "chain-show",
        summary: "Show each harness's failover chain and the accounts it expands to",
        usage: "bb gateway chain show [--json]",
      },
      {
        name: "chain-set",
        summary: "Set one harness's failover chain",
        usage: "bb gateway chain set <harness> <entry>...",
      },
      {
        name: "model-map-show",
        summary: "Show the model names used for each upstream kind",
        usage: "bb gateway model-map show [--json]",
      },
      {
        name: "model-map-set",
        summary: "Map a client model pattern to an upstream model",
        usage: "bb gateway model-map set <kind>[:<label>] <pattern> <model>",
      },
      {
        name: "auto",
        summary: "Let Jev pick each user turn's model for a harness, or show the auto settings",
        usage: "bb gateway auto [<harness> [--key <label>] [--model <id>] [--off]]",
      },
      {
        name: "account-hold",
        summary: "Test hook: treat an account as exhausted until a time",
        usage: "bb gateway account hold <id> --until <+1h|ISO time> | --clear",
      },
      {
        name: "routing",
        summary: "Enable or disable Model Gateway routing for one provider or ACP harness",
        usage:
          "bb gateway routing <claude|codex|acp-omp|acp-fx|acp-nanocodex|pi> [--off]",
      },
      {
        name: "config",
        summary: "Show Model Gateway routing configuration",
        usage: "bb gateway config",
      },
      {
        name: "config-set",
        summary: "Update one Model Gateway routing configuration value",
        usage:
          "bb gateway config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold> <value>",
      },
      {
        name: "token-rotate",
        summary: "Rotate one machine's Model Gateway bearer token",
        usage: "bb gateway token rotate --machine <id-or-name>",
      },
      {
        name: "bypass",
        summary: "Bypass Model Gateway routing for one thread",
        usage: "bb gateway bypass <thread-id> [--off]",
      },
      {
        name: "doctor",
        summary:
          "Report Account Pooler coexistence and per-host provider health",
        usage: "bb gateway doctor",
      },
      {
        name: "import-pool",
        summary:
          "Copy accounts and secrets from the core Account Pooler into the Model Gateway",
        usage: "bb gateway import-pool",
      },
      {
        name: "setup",
        summary:
          "Set up omp and Pi, or print the steps for FX and nanocodex, to run through the gateway",
        usage:
          "bb gateway setup omp [--print] [--server-url <url>]\nbb gateway setup fx\nbb gateway setup nanocodex\nbb gateway setup pi [--print]",
      },
    ],
    async run(argv, ctx): Promise<PluginCliResult> {
      try {
        if (argv.includes("--help") || argv.includes("-h")) {
          return { exitCode: 0, stdout: `${HELP}\n` };
        }
        if (argv[0] === "account" && argv[1] === "priority") {
          if (argv.length !== 4 || argv[3]?.trim() === "")
            throw new Error(HELP);
          const input = accountPriorityInputSchema.parse({
            accountId: argv[2],
            priority: Number(argv[3]),
          });
          const account = await operations.setPriority(
            input.accountId,
            input.priority,
          );
          if (account === null) throw new Error("Account not found.");
          return {
            exitCode: 0,
            stdout: `Set ${account.label} priority to ${account.priority}.\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "reorder") {
          const input = accountReorderInputSchema.parse({
            provider: argv[2],
            accountIds: argv.slice(3),
          });
          await operations.reorder(input.provider, input.accountIds);
          return {
            exitCode: 0,
            stdout: `Updated ${input.provider} account order.\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "add") {
          const flags = parseFlags(
            argv.slice(2),
            ["import", "api-key-stdin", "login"],
            ["provider", "api-key", "label", "priority"],
          );
          const imported = flags.booleans.has("import");
          const apiKeyStdin = flags.booleans.has("api-key-stdin");
          const loginRequested = flags.booleans.has("login");
          const apiKey = flags.values.get("api-key");
          const sourceCount =
            Number(imported) +
            Number(apiKeyStdin) +
            Number(loginRequested) +
            Number(apiKey !== undefined);
          if (sourceCount !== 1)
            throw new Error(
              "Choose exactly one of --login, --import, --api-key-stdin, or --api-key <key>.",
            );
          if (loginRequested) {
            const provider = flags.values.get("provider");
            if (provider !== "claude" && provider !== "codex") {
              throw new Error(
                "--login requires --provider claude or --provider codex.",
              );
            }
            if (flags.values.has("label") || flags.values.has("priority")) {
              throw new Error("--login does not accept --label or --priority.");
            }
            if (provider === "codex") {
              const started = await codexLogin.start();
              return {
                exitCode: 0,
                stdout: `${[
                  "Open this URL to sign in to Codex:",
                  started.verificationUri,
                  "",
                  `Enter this code: ${started.userCode}`,
                  `Session ID: ${started.sessionId}`,
                  "",
                  "After authorizing, wait for the account to be added with:",
                  `bb gateway account login-poll --session ${started.sessionId}`,
                ].join("\n")}\n`,
              };
            }
            const started = login.start();
            return {
              exitCode: 0,
              stdout: `${[
                "Open this URL to sign in to Claude:",
                started.authorizeUrl,
                "",
                `Session ID: ${started.sessionId}`,
                "",
                "After signing in, pipe the code shown on the final page into:",
                `printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb gateway account login-complete --session ${started.sessionId} --code-stdin`,
              ].join("\n")}\n`,
            };
          }
          if (apiKeyStdin) {
            throw new Error(
              "--api-key-stdin must be invoked through the bb CLI so it can read stdin safely.",
            );
          }
          if (!imported && flags.values.get("provider") !== "claude") {
            throw new Error("Anthropic API keys require --provider claude.");
          }
          const priorityText = flags.values.get("priority") ?? "100";
          const input = accountAddInputSchema.parse({
            provider: flags.values.get("provider"),
            source: imported ? { kind: "import" } : { kind: "api-key", apiKey },
            label: flags.values.get("label") ?? null,
            priority: Number(priorityText),
          });
          const account = await operations.add(input);
          return {
            exitCode: 0,
            stdout: `Added ${account.label} (${account.id}).\n`,
          };
        }
        if (argv[0] === "key" && argv[1] === "add") {
          // The bb CLI turns --key-stdin into --key <line from stdin>.
          const flags = parseFlags(
            argv.slice(3),
            ["key-stdin"],
            ["label", "base-url", "key", "priority"],
          );
          const apiKey = flags.values.get("key");
          if (flags.booleans.has("key-stdin") || apiKey === undefined)
            throw new Error(
              `Pipe the key in through the bb CLI: printf '%s\\n' "$KEY" | bb gateway key add ${argv[2] ?? "<kind>"} --label <label> [--base-url <url>] --key-stdin`,
            );
          const parsed = keyAddInputSchema.safeParse({
            kind: argv[2],
            label: flags.values.get("label"),
            baseUrl: flags.values.get("base-url"),
            apiKey,
            priority: Number(flags.values.get("priority") ?? "100"),
          });
          // Issue messages only: never echo the input, which holds the key.
          if (!parsed.success)
            throw new Error(
              parsed.error.issues
                .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
                .join("\n"),
            );
          const account = await operations.addKey(parsed.data);
          return {
            exitCode: 0,
            stdout: `${[
              `Added ${parsed.data.kind}:${account.label} (${account.id}).`,
              `Add it to a chain, for example: bb gateway chain set codex chatgpt-oauth:* ${parsed.data.kind}:${account.label}`,
              "API keys bill per token.",
            ].join("\n")}\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "login-poll") {
          const flags = parseFlags(argv.slice(2), [], ["session"]);
          const input = codexLoginPollInputSchema.parse({
            sessionId: flags.values.get("session"),
          });
          const signal = ctx.signal;
          const cancel = () => codexLogin.cancel(input);
          signal?.addEventListener("abort", cancel, { once: true });
          try {
            if (signal?.aborted) {
              cancel();
              throw signal.reason ?? new Error("Codex login was cancelled.");
            }
            while (true) {
              await wait(
                codexLogin.nextPollDelayMs(input.sessionId),
                undefined,
                { signal },
              );
              const result = await codexLogin.poll(input);
              if (signal?.aborted) {
                throw signal.reason ?? new Error("Codex login was cancelled.");
              }
              if (result.status === "complete") {
                return {
                  exitCode: 0,
                  stdout: `Added ${result.account.label} (${result.account.id}).\n`,
                };
              }
              if (result.status === "error") {
                throw new Error(result.message);
              }
            }
          } catch (error) {
            if (signal?.aborted) codexLogin.cancel(input);
            throw error;
          } finally {
            signal?.removeEventListener("abort", cancel);
          }
        }
        if (argv[0] === "account" && argv[1] === "login-complete") {
          const flags = parseFlags(
            argv.slice(2),
            ["code-stdin"],
            ["session", "code"],
          );
          if (flags.booleans.has("code-stdin")) {
            throw new Error(
              "--code-stdin requires the current bb CLI so it can read stdin safely.",
            );
          }
          const input = loginCompleteInputSchema.parse({
            sessionId: flags.values.get("session"),
            pasted: flags.values.get("code"),
          });
          const account = await login.complete(input);
          return {
            exitCode: 0,
            stdout: `Added ${account.label} (${account.id}).\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "list") {
          const flags = parseFlags(argv.slice(2), ["json"], []);
          const accounts = await operations.list();
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json({ accounts })
              : `${formatAccounts(accounts)}\n`,
          };
        }
        if (
          argv[0] === "account" &&
          ["remove", "enable", "disable"].includes(argv[1] ?? "")
        ) {
          if (argv.length !== 3) throw new Error(HELP);
          const { id } = accountIdInputSchema.parse({ id: argv[2] });
          if (argv[1] === "remove") {
            const removed = await operations.remove(id);
            if (!removed) throw new Error(`Account ${id} does not exist.`);
            return { exitCode: 0, stdout: `Removed ${id}.\n` };
          }
          const account =
            argv[1] === "enable"
              ? await operations.enable(id)
              : await operations.disable(id);
          if (account === null)
            throw new Error(`Account ${id} does not exist.`);
          return {
            exitCode: 0,
            stdout: `${argv[1] === "enable" ? "Enabled" : "Disabled"} ${id}.\n`,
          };
        }
        if (argv[0] === "status") {
          const flags = parseFlags(argv.slice(1), ["json"], ["thread"]);
          const threadId = flags.values.get("thread");
          if (threadId !== undefined) {
            const route = await operations.threadStatus(threadId);
            if (route === null)
              throw new Error(`Thread ${threadId} has no Model Gateway route yet.`);
            return {
              exitCode: 0,
              stdout: flags.booleans.has("json")
                ? json(route)
                : `${formatThreadStatus(route)}\n`,
            };
          }
          const status = await operations.status();
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json(status)
              : `${formatStatus(status)}\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "hold") {
          const flags = parseFlags(argv.slice(3), ["clear"], ["until"]);
          const { id } = accountIdInputSchema.parse({ id: argv[2] });
          const until = flags.values.get("until");
          if (flags.booleans.has("clear") === (until !== undefined))
            throw new Error("Choose exactly one of --until <time> or --clear.");
          const heldUntil =
            until === undefined ? null : parseUntil(until, Date.now());
          const account = await operations.holdAccount(id, heldUntil);
          if (account === null) throw new Error(`Account ${id} does not exist.`);
          return {
            exitCode: 0,
            stdout:
              heldUntil === null
                ? `Cleared the hold on ${account.label}.\n`
                : `Held ${account.label} until ${new Date(heldUntil).toISOString()}.\n`,
          };
        }
        if (argv[0] === "chain" && argv[1] === "show") {
          const flags = parseFlags(argv.slice(2), ["json"], []);
          const { chains } = config.get();
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json(chains)
              : `${formatChains(chains, await operations.list())}\n`,
          };
        }
        if (argv[0] === "chain" && argv[1] === "set") {
          const next = await setChain(
            config,
            harnessSchema.parse(argv[2]),
            argv.slice(3),
          );
          return {
            exitCode: 0,
            stdout: `${formatChains(next.chains, await operations.list())}\n`,
          };
        }
        if (argv[0] === "model-map" && argv[1] === "show") {
          const flags = parseFlags(argv.slice(2), ["json"], []);
          const { modelMap } = config.get();
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json(modelMap)
              : `${formatModelMap(modelMap)}\n`,
          };
        }
        if (argv[0] === "model-map" && argv[1] === "set") {
          if (argv.length !== 5) throw new Error(HELP);
          const [key = "", pattern = "", model = ""] = argv.slice(2);
          const next = await setModelMapEntry(config, key, pattern, model);
          return { exitCode: 0, stdout: `${formatModelMap(next.modelMap)}\n` };
        }
        if (argv[0] === "auto") {
          const current = config.get().auto;
          if (argv[1] === undefined || argv[1] === "show")
            return { exitCode: 0, stdout: `${formatAuto(current)}\n` };
          const harness = harnessSchema.parse(argv[1]);
          const flags = parseFlags(argv.slice(2), ["off"], ["key", "model"]);
          const next = await setAuto(config, await operations.list(), {
            harness,
            off: flags.booleans.has("off"),
            key: flags.values.get("key"),
            model: flags.values.get("model"),
          });
          return { exitCode: 0, stdout: `${formatAuto(next.auto)}\n` };
        }
        if (argv[0] === "routing") {
          const flags = parseFlags(argv.slice(2), ["off"], []);
          const input = routingSetInputSchema.parse({
            provider: argv[1],
            enabled: !flags.booleans.has("off"),
          });
          await operations.setRouting(input.provider, input.enabled);
          return {
            exitCode: 0,
            stdout: `${input.enabled ? "Enabled" : "Disabled"} ${input.provider} Model Gateway routing.\n`,
          };
        }
        if (argv[0] === "config" && argv.length === 1) {
          return { exitCode: 0, stdout: `${formatConfig(config.get())}\n` };
        }
        if (argv[0] === "config" && argv[1] === "set") {
          if (argv.length !== 4) throw new Error(HELP);
          const next = await config.set(parseConfigUpdate(argv[2], argv[3]));
          return { exitCode: 0, stdout: `${formatConfig(next)}\n` };
        }
        if (argv[0] === "token" && argv[1] === "rotate") {
          const flags = parseFlags(argv.slice(2), [], ["machine"]);
          const { machine } = tokenRotateInputSchema.parse({
            machine: flags.values.get("machine"),
          });
          const token = await operations.rotateToken(machine);
          return {
            exitCode: 0,
            stdout: `Rotated the Model Gateway token for ${token.hostName ?? token.hostId}.\n`,
          };
        }
        if (argv[0] === "bypass") {
          const threadId = argv[1];
          if (threadId === undefined) throw new Error(HELP);
          const flags = parseFlags(argv.slice(2), ["off"], []);
          const input = bypassInputSchema.parse({
            threadId,
            bypassed: !flags.booleans.has("off"),
          });
          const result = await operations.setBypass(
            input.threadId,
            input.bypassed,
          );
          return {
            exitCode: 0,
            stdout: `${result.bypassed ? "Enabled" : "Disabled"} Model Gateway bypass for ${result.threadId}.\n`,
          };
        }
        if (argv[0] === "doctor") {
          return { exitCode: 0, stdout: `${await runDoctor()}\n` };
        }
        if (argv[0] === "import-pool") {
          const result = await runImportPool();
          const lines = [
            `Imported ${result.importedAccountIds.length} account${result.importedAccountIds.length === 1 ? "" : "s"}.`,
          ];
          if (result.skippedExistingIds.length > 0) {
            lines.push(
              `Skipped ${result.skippedExistingIds.length} already present.`,
            );
          }
          if (result.importedAccountIds.length > 0) {
            lines.push(
              "Run `bb plugin reload model-gateway` to clear the needs-configuration status.",
            );
          }
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        if (argv[0] === "setup" && argv[1] === "fx" && argv.length === 2)
          return { exitCode: 0, stdout: FX_SETUP };
        if (argv[0] === "setup" && argv[1] === "nanocodex" && argv.length === 2)
          return { exitCode: 0, stdout: NANOCODEX_SETUP };
        if (argv[0] === "setup" && argv[1] === "pi") {
          const flags = parseFlags(argv.slice(2), ["print"], []);
          // Pi threads pick the ChatGPT models of the model map; the chain decides the upstream.
          const models = [
            ...new Set(Object.values(config.get().modelMap["chatgpt-oauth"] ?? {})),
          ];
          if (flags.booleans.has("print"))
            return {
              exitCode: 0,
              stdout: `Save this as ~/.pi/agent/extensions/model-gateway.js:\n\n${piExtension(models)}`,
            };
          const result = await writePiExtension(
            process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
            models,
            Date.now(),
          );
          return {
            exitCode: 0,
            stdout: `${[
              result.changed
                ? `Wrote the model-gateway Pi extension to ${result.file} on the BB server machine.`
                : `${result.file} is already up to date.`,
              ...(result.backup === null ? [] : [`Backup: ${result.backup}`]),
              `In a Pi thread, pick a model-gateway model (${models.join(", ")}).`,
              "Other hosts and sandboxes: save bb gateway setup pi --print there. The file is the same on every host.",
            ].join("\n")}\n`,
          };
        }
        if (argv[0] === "setup" && argv[1] === "omp") {
          const flags = parseFlags(argv.slice(2), ["print"], ["server-url"]);
          const baseUrl = gatewayBaseUrl(
            flags.values.get("server-url") ?? bb.server.loopbackBaseUrl,
          );
          if (flags.booleans.has("print"))
            return {
              exitCode: 0,
              stdout: `Add this under providers: in ~/.omp/agent/models.yml:\n\n${ompSnippet(baseUrl)}`,
            };
          const result = await writeOmpProvider(homedir(), baseUrl, Date.now());
          return {
            exitCode: 0,
            stdout: `${[
              result.changed
                ? `Wrote the model-gateway provider into ${result.file} on the BB server machine.`
                : `${result.file} already has the model-gateway provider.`,
              ...(result.backup === null ? [] : [`Backup: ${result.backup}`]),
              `baseUrl: ${baseUrl}`,
              "In an acp-omp thread, pick a gw-* model (for example gw-gpt-6-astra).",
              "Other hosts: bb gateway setup omp --print --server-url <that host's BB_SERVER_URL>.",
            ].join("\n")}\n`,
          };
        }
        throw new Error(HELP);
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}
