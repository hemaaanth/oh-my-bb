// Chain config, legal guard, thread tokens, sticky rules, exhaustion and
// context guard for the Model Gateway hub (plan sections 3, 4.3-4.5, 4.7).
// Pure functions; the hub and the stores call these.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Account, AccountQuota, ModelFamily } from "./contracts.js";
import type { ProviderAdapter } from "./upstreams/provider-adapter.js";
import { isQuotaExhausted } from "./upstreams/quota.js";
import { ANTHROPIC_REPLAY, CHATGPT_REPLAY } from "./translate/reasoning-envelope.js";
import {
  HARNESSES,
  KEY_LABEL,
  UPSTREAM_KINDS,
  upstreamKind,
  entryTitle,
  type UpstreamKind,
} from "./upstream-kind.js";

export { HARNESSES, KEY_LABEL, UPSTREAM_KINDS, upstreamKind, entryTitle };

export const harnessSchema = z.enum(HARNESSES);
export type Harness = z.infer<typeof harnessSchema>;

export const upstreamKindSchema = z.enum(UPSTREAM_KINDS);
export type { UpstreamKind };

const KINDS = UPSTREAM_KINDS.join("|");
/** `<kind>:*` (every account of the kind) or `<kind>:<label>` (one account). */
const KIND_ENTRY = new RegExp(`^(${KINDS}):(\\*|[A-Za-z0-9._-]+)$`, "u");
export const chainEntrySchema = z
  .string()
  .refine(
    (value) => KIND_ENTRY.test(value) || z.uuid().safeParse(value).success,
    `Chain entries are <kind>:*, <kind>:<label>, or an account id. Kinds: ${UPSTREAM_KINDS.join(", ")}.`,
  );
const chainSchema = z.array(chainEntrySchema).min(1);

export const DEFAULT_CHAINS: Record<Harness, string[]> = {
  "claude-code": ["claude-oauth:*", "claude-key:*", "chatgpt-oauth:*"],
  codex: ["chatgpt-oauth:*"],
  "acp-omp": ["chatgpt-oauth:*"],
  "acp-fx": ["chatgpt-oauth:*"],
  "acp-nanocodex": ["chatgpt-oauth:*"],
  pi: ["chatgpt-oauth:*"],
};

export const chainsSchema = z
  .object({
    "claude-code": chainSchema.default(DEFAULT_CHAINS["claude-code"]),
    codex: chainSchema.default(DEFAULT_CHAINS.codex),
    "acp-omp": chainSchema.default(DEFAULT_CHAINS["acp-omp"]),
    "acp-fx": chainSchema.default(DEFAULT_CHAINS["acp-fx"]),
    "acp-nanocodex": chainSchema.default(DEFAULT_CHAINS["acp-nanocodex"]),
    pi: chainSchema.default(DEFAULT_CHAINS.pi),
  })
  .strict();
export type Chains = z.infer<typeof chainsSchema>;

// Decision 8.3, superseded 2026-09-28 with the current fallback tiers.
export const DEFAULT_MODEL_MAP: Record<string, Record<string, string>> = {
  "chatgpt-oauth": {
    "claude-fable-*": "gpt-6-astra",
    "claude-opus-*": "gpt-6-sol",
    "claude-sonnet-*": "gpt-5.6-terra",
    "claude-haiku-*": "gpt-6-luna",
  },
};

/** Model-map keys: an upstream kind, or `<kind>:<label>` for one key (wins over the kind). */
export const modelMapKeySchema = z
  .string()
  .regex(
    new RegExp(`^(${KINDS})(:[A-Za-z0-9._-]+)?$`, "u"),
    `Model-map keys are <kind> or <kind>:<label>. Kinds: ${UPSTREAM_KINDS.join(", ")}.`,
  );
export const modelMapSchema = z.record(
  modelMapKeySchema,
  z.record(z.string().min(1), z.string().min(1)),
);
export type ModelMap = z.infer<typeof modelMapSchema>;

type UpstreamAccount = Pick<Account, "provider" | "kind" | "baseUrl" | "label">;

/**
 * Who minted a thinking or reasoning block, for replay (plan 9, P4 risks a and b).
 * Anthropic accounts share one identity, ChatGPT accounts another; each
 * compatible key is its own (`<kind>:<label>`). A block is only ever replayed
 * to the identity that minted it.
 */
export function replayIdentity(
  account: Pick<Account, "provider" | "kind" | "baseUrl" | "label">,
): string {
  const kind = upstreamKind(account);
  if (kind === "claude-oauth" || kind === "claude-key") return ANTHROPIC_REPLAY;
  return kind === "chatgpt-oauth" ? CHATGPT_REPLAY : `${kind}:${account.label}`;
}

/**
 * Expands chain entries to enabled accounts. `<kind>:*` keeps the ported
 * priority order (priority, then order added). An account appears once, at
 * its first entry. Entries that match nothing stay as empty lists so entry
 * indexes match the configured chain.
 */
export function expandChain(
  entries: readonly string[],
  accounts: readonly Account[],
): Account[][] {
  const ordered = accounts
    .filter((account) => account.enabled)
    .sort((left, right) => left.priority - right.priority);
  const seen = new Set<string>();
  return entries.map((entry) => {
    const [, kind, label] = KIND_ENTRY.exec(entry) ?? [];
    const matched = ordered.filter(
      (account) =>
        !seen.has(account.id) &&
        (kind === undefined
          ? account.id === entry
          : upstreamKind(account) === kind &&
            (label === "*" || account.label === label)),
    );
    for (const account of matched) seen.add(account.id);
    return matched;
  });
}

/**
 * Legal guard (plan 4.4). Claude Max OAuth serves only a verified Claude Code
 * token on a Messages path. Every other upstream kind serves any harness.
 */
export function isLegalUpstream(
  kind: UpstreamKind,
  harness: Harness | null,
  path: string,
): boolean {
  if (kind !== "claude-oauth") return true;
  return harness === "claude-code" && /^\/v1\/messages(\/|$)/u.test(path);
}

/** Why a chain entry may not sit in this harness's chain; null when it may. */
export function chainEntryBlock(
  entry: string,
  harness: Harness,
  accounts: readonly Account[],
): string | null {
  const account = accounts.find(({ id }) => id === entry);
  if (!KIND_ENTRY.test(entry) && account === undefined)
    return `Chain entry ${entry} is not a known account id.`;
  const kind =
    account === undefined ? KIND_ENTRY.exec(entry)?.[1] : upstreamKind(account);
  return kind === "claude-oauth" && harness !== "claude-code"
    ? "Claude OAuth accounts serve only the claude-code harness"
    : null;
}

/** Rejects chains that would put Claude OAuth behind a non-Claude-Code harness. */
export function assertLegalChains(
  chains: Chains,
  accounts: readonly Account[],
): void {
  for (const harness of HARNESSES) {
    for (const entry of chains[harness]) {
      const block = chainEntryBlock(entry, harness, accounts);
      if (block === null) continue;
      throw new Error(
        block.endsWith(".")
          ? block
          : `${block}; remove ${entry} from the ${harness} chain.`,
      );
    }
  }
}

/**
 * Entries the settings pane offers for a harness's chain: each `<kind>:*`, plus
 * the entries it names now (per-account entries come from `bb gateway chain set`).
 * `label` is the plain name; `blocked` is the legal guard's reason.
 */
export function chainEntryOptions(
  chains: Chains,
  accounts: readonly Account[],
): Record<Harness, Array<{ entry: string; label: string; blocked: string | null }>> {
  return Object.fromEntries(
    HARNESSES.map((harness) => [
      harness,
      [...new Set([...UPSTREAM_KINDS.map((kind) => `${kind}:*`), ...chains[harness]])].map(
        (entry) => ({
          entry,
          label: entryTitle(entry, accounts),
          blocked: chainEntryBlock(entry, harness, accounts),
        }),
      ),
    ]),
  ) as Record<Harness, Array<{ entry: string; label: string; blocked: string | null }>>;
}

/** A kind, or an account: its `<kind>:<label>` map first, then its kind's map. */
export function mapModel(
  modelMap: ModelMap,
  upstream: UpstreamKind | UpstreamAccount,
  model: string | null,
): string | null {
  if (model === null) return null;
  const keys =
    typeof upstream === "string"
      ? [upstream]
      : [`${upstreamKind(upstream)}:${upstream.label}`, upstreamKind(upstream)];
  for (const key of keys) {
    for (const [pattern, target] of Object.entries(modelMap[key] ?? {})) {
      const source = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*");
      if (new RegExp(`^${source}$`, "iu").test(model)) return target;
    }
  }
  return null;
}

/**
 * omp resolves a model id it already knows to its built-in provider, not to
 * the gateway provider (S1). So omp sees each ChatGPT model as `gw-<model>`.
 */
export const OMP_MODEL_PREFIX = "gw-";

/** The `gw-` ids omp discovers: one per ChatGPT model in the model map. */
export function ompModels(modelMap: ModelMap): string[] {
  return [...new Set(Object.values(modelMap["chatgpt-oauth"] ?? {}))].map(
    (model) => OMP_MODEL_PREFIX + model,
  );
}

/**
 * Model for a same-protocol request that may need a new name: the model map
 * first, then `gw-<model>` -> `<model>` (mapped again, for key upstreams), else
 * unchanged (nanocodex `gpt-6-*`, FX's `gpt-5.6-luna` title call).
 */
export function gatewayModel(
  modelMap: ModelMap,
  upstream: UpstreamKind | UpstreamAccount,
  model: string | null,
): string | null {
  if (model === null) return null;
  const bare = model.startsWith(OMP_MODEL_PREFIX)
    ? model.slice(OMP_MODEL_PREFIX.length)
    : model;
  return (
    mapModel(modelMap, upstream, model) ??
    mapModel(modelMap, upstream, bare) ??
    bare
  );
}

// P5 (plan WP5.1): Jev automatic model choice, per harness.
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";
export const autoSchema = z
  .object({
    /** Harnesses whose new user turns ask Jev for a model. */
    harnesses: z.array(harnessSchema),
    /** Label of the responses-compatible-key that holds the OpenRouter key (decision 8.7). */
    key: z.string().regex(KEY_LABEL).nullable(),
    /** OpenRouter model id of Jev. */
    model: z.string().min(1),
  })
  .strict();
export type AutoSettings = z.infer<typeof autoSchema>;
export const DEFAULT_AUTO: AutoSettings = {
  harnesses: [],
  key: null,
  model: DEFAULT_JEV_MODEL,
};

// ponytail: fixed Claude ids; make them a setting when they go stale. Haiku is left
// out: Claude Code's main-turn bodies carry effort and thinking fields Haiku rejects.
const CLAUDE_LADDER = ["claude-sonnet-5", "claude-opus-5-5"];
const TIERS = [/luna|haiku|mini/iu, /sol|sonnet/iu, /astra|opus|fable/iu];
const tierOf = (model: string) => {
  const index = TIERS.findIndex((pattern) => pattern.test(model));
  return index < 0 ? TIERS.length : index;
};

/**
 * The client models Jev may pick, cheapest first: Claude ids for Claude Code, the
 * ChatGPT models of the model map for the Responses harnesses.
 */
export function autoLadder(harness: Harness, modelMap: ModelMap): string[] {
  if (harness === "claude-code") return CLAUDE_LADDER;
  return [...new Set(Object.values(modelMap["chatgpt-oauth"] ?? {}))].sort(
    (left, right) => tierOf(left) - tierOf(right),
  );
}

/**
 * True when auto may re-route a request for this model. Side calls keep their
 * model: Claude Code's Haiku calls, FX's `gpt-5.6-luna` title, nanocodex `kimi-k3`.
 */
export function onAutoLadder(
  harness: Harness,
  ladder: readonly string[],
  model: string | null,
): boolean {
  if (model === null) return false;
  if (harness === "claude-code") return /^claude-(?:sonnet|opus|fable)-/iu.test(model);
  return ladder.includes(
    model.startsWith(OMP_MODEL_PREFIX) ? model.slice(OMP_MODEL_PREFIX.length) : model,
  );
}

/**
 * Main turns carry client tools (also nanocodex's `additional_tools` input item).
 * Claude Code's session-title call has none; its WebSearch sub-request has only a
 * server tool.
 */
export function hasClientTools(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  return [
    ...list(body.tools),
    ...list(body.input).flatMap((item) =>
      isRecord(item) && item.type === "additional_tools" ? list(item.tools) : [],
    ),
  ].some(
    (tool) =>
      isRecord(tool) &&
      (tool.type === undefined ||
        tool.type === "custom" ||
        tool.type === "function" ||
        tool.type === "namespace"),
  );
}

/** nanocodex ids that no ChatGPT account serves. */
const API_KEY_ONLY_MODEL = /^(?:kimi-|mimo-|@cf\/)/u;

export function needsApiKeyUpstream(model: string | null): boolean {
  return model !== null && API_KEY_ONLY_MODEL.test(model);
}

export function apiKeyUpstreamMessage(model: string): string {
  return `Gateway: ${model} needs an API-key upstream in this harness's chain. Add one with bb gateway key add anthropic-compatible-key --label <label> --base-url <url> --key-stdin and bb gateway chain set, or map ${model} to a ChatGPT model with bb gateway model-map set chatgpt-oauth ${model} <model>.`;
}

// The ChatGPT Codex backend rejects these (see translate/messages-to-responses.ts).
const CHATGPT_REJECTED_FIELDS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "stop",
  "user",
];

/**
 * A Responses body from omp, FX or nanocodex, fitted to the ChatGPT Codex
 * backend: the gateway model, and no sampling or output-limit fields. Every
 * other field, including nanocodex's `additional_tools` input item, is kept.
 */
export function fitForChatGpt(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const fitted: Record<string, unknown> = { ...body, model };
  for (const field of CHATGPT_REJECTED_FIELDS) delete fitted[field];
  return fitted;
}

export interface ThreadIdentity {
  hostId: string;
  threadId: string;
  harness: Harness;
}

function threadTokenMac(secret: string, payload: string): Buffer {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(payload)
    .digest();
}

/** Per-thread hub token: base64url([hostId, threadId, harness]) "." HMAC(hostSecret). */
export function signThreadToken(
  secret: string,
  identity: ThreadIdentity,
): string {
  const payload = Buffer.from(
    JSON.stringify([identity.hostId, identity.threadId, identity.harness]),
  ).toString("base64url");
  return `${payload}.${threadTokenMac(secret, payload).toString("base64url")}`;
}

const tokenPayloadSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  harnessSchema,
]);

/** Reads the claimed identity. Unverified: check it with verifyThreadToken. */
export function readThreadToken(token: string): ThreadIdentity | null {
  const [payload, mac, extra] = token.split(".");
  if (payload === undefined || mac === undefined || extra !== undefined)
    return null;
  try {
    const parsed = tokenPayloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (!parsed.success) return null;
    const [hostId, threadId, harness] = parsed.data;
    return { hostId, threadId, harness };
  } catch {
    return null;
  }
}

export function verifyThreadToken(secret: string, token: string): boolean {
  const [payload = "", mac = ""] = token.split(".");
  const expected = Buffer.from(
    threadTokenMac(secret, payload).toString("base64url"),
  );
  const presented = Buffer.from(mac);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Plan 4.3 step 2. True when the body ends with a plain user message (a new
 * user turn); false when it ends with a tool result (mid tool-loop) or is not
 * readable. Handles Messages (`messages[]`) and Responses (`input`) bodies.
 */
export function isNewUserTurn(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (Array.isArray(body.messages)) {
    const last = body.messages
      .filter((message) => !isRecord(message) || message.role !== "system")
      .at(-1);
    if (!isRecord(last) || last.role !== "user") return false;
    return (
      typeof last.content === "string" ||
      (Array.isArray(last.content) &&
        !last.content.some(
          (block) => isRecord(block) && block.type === "tool_result",
        ))
    );
  }
  if (typeof body.input === "string") return true;
  if (!Array.isArray(body.input)) return false;
  const last = body.input.at(-1);
  return (
    isRecord(last) &&
    last.role === "user" &&
    (last.type === undefined || last.type === "message")
  );
}

/**
 * Sticky order (plan 4.5). A thread bound past entry 0 starts at its bound
 * entry while the primary has not reset, and always mid tool-loop. Earlier
 * entries move to the end: they are a last resort, not skipped forever.
 */
export function orderEntries(
  count: number,
  boundIndex: number,
  stickyUntil: number | null,
  newUserTurn: boolean,
  now: number,
): { order: number[]; sticky: boolean } {
  const all = [...Array(count).keys()];
  const sticky =
    boundIndex > 0 &&
    boundIndex < count &&
    (!newUserTurn || (stickyUntil !== null && now < stickyUntil));
  return {
    order: sticky
      ? [...all.slice(boundIndex), ...all.slice(0, boundIndex)]
      : all,
    sticky,
  };
}

/**
 * Latest reset among the quota windows that block this family. Null when the
 * quota does not block; `resetAt: null` when it blocks with no known reset.
 */
export function exhaustedUntil(
  quota: AccountQuota,
  family: ModelFamily,
  threshold: number,
  now: number,
): { resetAt: number | null } | null {
  if (!isQuotaExhausted(quota, family, threshold, now)) return null;
  const family7d = quota.familyWeekly[family];
  const windows: Array<
    [number | null | undefined, string | null | undefined, number | null | undefined]
  > = [
    [quota.fiveHourUtilization, quota.fiveHourStatus, quota.fiveHourResetAt],
    [quota.sevenDayUtilization, quota.sevenDayStatus, quota.sevenDayResetAt],
    [family7d?.utilization, family7d?.status, family7d?.resetAt],
    ...quota.limitWindows.map(
      (window) =>
        [window.utilization, window.status, window.resetAt] as [
          number | null,
          string | null,
          number | null,
        ],
    ),
  ];
  let resetAt: number | null = null;
  for (const [utilization, status, reset] of windows) {
    const blocks =
      status?.toLowerCase() === "rejected" ||
      (utilization != null && utilization >= threshold);
    if (blocks && reset != null && reset > now)
      resetAt = Math.max(resetAt ?? reset, reset);
  }
  return { resetAt };
}

const PLACEHOLDER_ACCOUNT_ID = "00000000-0000-4000-8000-000000000000";

/**
 * S6 exhaustion rule: HTTP 429 plus the adapter's header-only rejection check
 * (ChatGPT `x-codex-*-used-percent >= 100` / `-over-limit`; Anthropic
 * `anthropic-ratelimit-unified-*-status: rejected`). The reset time comes from
 * the ported header parsers. Returns null for other responses.
 */
export function responseExhaustion(
  adapter: Pick<ProviderAdapter, "isQuotaRejection" | "quotaFromHeaders">,
  status: number,
  headers: Headers,
  family: ModelFamily,
  empty: AccountQuota,
  now: number,
): { resetAt: number | null } | null {
  if (status !== 429 || !adapter.isQuotaRejection(headers)) return null;
  const quota = adapter.quotaFromHeaders(
    PLACEHOLDER_ACCOUNT_ID,
    headers,
    { ...empty, accountId: PLACEHOLDER_ACCOUNT_ID },
    family,
    now,
  );
  return exhaustedUntil(quota, family, 1, now) ?? { resetAt: null };
}

// Input context windows. GPT values from the Codex model catalog
// (`context_window` 272000 for gpt-6-* and gpt-5.x).
const CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude-/iu, 200_000],
  [/^gpt-/iu, 272_000],
];

/** Null when the model is unknown: the guard then does not apply. */
export function contextWindow(
  model: string | null,
  headers: Headers,
): number | null {
  if (model === null) return null;
  if (
    /^claude-/iu.test(model) &&
    headers.get("anthropic-beta")?.includes("context-1m") === true
  )
    return 1_000_000;
  return CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model))?.[1] ?? null;
}

export function contextExceededMessage(tokens: number): string {
  return `Gateway: context (${tokens} tokens) exceeds every available fallback model. Compact the thread.`;
}

/** Path below the plugin HTTP mount, e.g. `/v1/messages/count_tokens`. */
export function routePath(url: string): string {
  const pathname = new URL(url).pathname;
  const mounted = pathname.indexOf("/http/");
  return mounted < 0 ? pathname : pathname.slice(mounted + 5);
}
