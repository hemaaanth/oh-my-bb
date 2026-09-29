// API-key upstreams with their own base URL (plan WP4.1): Anthropic-compatible
// Messages keys (Kimi, GLM, ...) and Responses-compatible keys (OpenAI API,
// OpenRouter, ...). The base URL is what the vendor documents for
// ANTHROPIC_BASE_URL or OPENAI_BASE_URL. Quota is plain 429 holds plus a
// credit-exhaustion bench; there are no quota headers to read.
import type { PoolProvider } from "../contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { filterRequestHeaders, mountedUpstreamUrl } from "./provider-adapter.js";

/** How long an out-of-credit key sits out before the hub tries it again. */
export const CREDIT_BENCH_MS = 30 * 60 * 1_000;
const CREDIT_READ_TIMEOUT_MS = 1_000;
const ANTHROPIC_VERSION = "2023-06-01";

const ALLOWED_REQUEST_HEADERS: Record<PoolProvider, Set<string>> = {
  claude: new Set(["accept", "content-type", "user-agent", "anthropic-version", "anthropic-beta"]),
  codex: new Set(["accept", "content-type", "user-agent", "openai-beta"]),
};

// Error bodies that mean "this key has no money left", across vendors:
// OpenAI `insufficient_quota`, Anthropic "credit balance is too low", Moonshot
// `exceeded_current_quota_error`, and the generic balance/billing wording.
const CREDIT_EXHAUSTED =
  /insufficient_quota|exceeded_current_quota|credit balance|insufficient (?:balance|credits?|funds)|balance is (?:too low|insufficient)|payment required|billing/iu;

/**
 * True when the key has run out of credit: HTTP 402, or a 400/403/429 whose
 * body says so. Reads a clone, so the caller can still use the original body.
 */
export async function isCreditExhausted(response: Response): Promise<boolean> {
  if (response.status === 402) return true;
  if (![400, 403, 429].includes(response.status)) return false;
  // Always cancel the clone: an unread tee branch keeps the upstream open.
  const reader = response.clone().body?.getReader();
  if (reader === undefined) return false;
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CREDIT_READ_TIMEOUT_MS);
  });
  try {
    while (text.length < 4_096) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk === null || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    // An unreadable body is not a credit answer.
  } finally {
    clearTimeout(timer);
    // Not awaited: a tee branch's cancel settles only once the other branch cancels too.
    void reader.cancel().catch(() => undefined);
  }
  return CREDIT_EXHAUSTED.test(text);
}

/** `protocol` is the wire protocol the key speaks: claude = Messages, codex = Responses. */
export function createKeyAdapter(
  protocol: PoolProvider,
  base: ProviderAdapter,
): ProviderAdapter {
  return {
    provider: protocol,
    upstreamName: protocol === "claude" ? "Anthropic-compatible API" : "Responses-compatible API",
    importAccount: () => Promise.reject(new Error("API keys are added with bb gateway key add.")),
    parseRequest: (body, headers) => base.parseRequest(body, headers),
    upstreamUrl(request, _settings, account) {
      if (account?.baseUrl === undefined)
        throw new Error("API-key upstreams need a base URL.");
      // Like the SDKs: Messages bases end before /v1, Responses bases end at /v1.
      return mountedUpstreamUrl(request, account.baseUrl, protocol === "codex" ? "v1/" : "");
    },
    requestHeaders(inbound, _account, secret) {
      if (secret.kind !== "api-key") throw new Error("Key upstreams need an API key.");
      const headers = filterRequestHeaders(inbound, ALLOWED_REQUEST_HEADERS[protocol], []);
      headers.set("authorization", `Bearer ${secret.apiKey}`);
      if (protocol === "claude") {
        // Compatible vendors document either header; send both to the same host.
        headers.set("x-api-key", secret.apiKey);
        if (!headers.has("anthropic-version")) headers.set("anthropic-version", ANTHROPIC_VERSION);
      }
      return headers;
    },
    quotaFromHeaders: (_accountId, _headers, previous) => previous,
    isQuotaRejection: () => false,
    refreshSecret: async ({ secret }) => ({ secret, refreshed: false }),
    errorResponse: (status, message, headers) => base.errorResponse(status, message, headers),
  };
}
