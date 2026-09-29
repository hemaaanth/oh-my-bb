// Harness and upstream-kind names shared by the server and the settings pane.
// No Node imports: app.tsx bundles this file for the browser.
import type { Account } from "./contracts.js";

export const HARNESSES = [
  "claude-code",
  "codex",
  "acp-omp",
  "acp-fx",
  "acp-nanocodex",
  "pi",
] as const;

export const UPSTREAM_KINDS = [
  "claude-oauth",
  "claude-key",
  "chatgpt-oauth",
  // P4: API keys for other vendors. Messages protocol (Kimi, GLM, ...) and
  // Responses protocol (OpenAI API, OpenRouter, ...), each with a base URL.
  "anthropic-compatible-key",
  "responses-compatible-key",
] as const;
export type UpstreamKind = (typeof UPSTREAM_KINDS)[number];

/** Key labels double as chain entries and model-map keys (`<kind>:<label>`). */
export const KEY_LABEL = /^[A-Za-z0-9._-]+$/u;

/**
 * Account -> upstream kind. `provider` is the wire protocol (claude = Messages,
 * codex = Responses); an API key with a base URL is a compatible-key upstream.
 */
export function upstreamKind(
  account: Pick<Account, "provider" | "kind" | "baseUrl">,
): UpstreamKind {
  if (account.kind === "oauth")
    return account.provider === "codex" ? "chatgpt-oauth" : "claude-oauth";
  if (account.provider === "codex") return "responses-compatible-key";
  return account.baseUrl === undefined ? "claude-key" : "anthropic-compatible-key";
}

/** Plain names for the settings pane and the thread badge. Raw kinds stay in the CLI. */
export const UPSTREAM_TITLES: Record<UpstreamKind, string> = {
  "claude-oauth": "Claude Max",
  "claude-key": "Anthropic API",
  "chatgpt-oauth": "ChatGPT",
  "anthropic-compatible-key": "Anthropic-compatible keys",
  "responses-compatible-key": "Responses-compatible keys",
};

/** A compatible key is named by its label alone (for example "kimi"). */
function upstreamTitle(kind: UpstreamKind, label: string): string {
  return kind.endsWith("-compatible-key")
    ? label
    : `${UPSTREAM_TITLES[kind]} (${label})`;
}

/**
 * Plain name of a chain entry: `<kind>:*` is the kind's name, `<kind>:<label>`
 * and an account id name the account. Unknown entries stay as written.
 */
export function entryTitle(
  entry: string,
  accounts: ReadonlyArray<Pick<Account, "id" | "label" | "provider" | "kind" | "baseUrl">>,
): string {
  const account = accounts.find(({ id }) => id === entry);
  if (account !== undefined) return upstreamTitle(upstreamKind(account), account.label);
  const split = entry.indexOf(":");
  const kind = entry.slice(0, split) as UpstreamKind;
  const label = entry.slice(split + 1);
  if (split < 0 || !(kind in UPSTREAM_TITLES)) return entry;
  return label === "*" ? UPSTREAM_TITLES[kind] : upstreamTitle(kind, label);
}
