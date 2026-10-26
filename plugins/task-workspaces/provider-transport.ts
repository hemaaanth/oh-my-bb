export type ProviderRequestContext = {
  provider: string;
  mutation: boolean;
};

type ProviderTransportOptions = {
  allowWrites: () => boolean | Promise<boolean>;
  secrets: () => string[] | Promise<string[]>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class HttpResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "HttpResponseError";
  }
}

function responseRetryAfterMs(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function redactSecrets(message: string, secrets: readonly string[]) {
  return secrets
    .filter((secret) => secret.length >= 6)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.replaceAll(secret, "[redacted]"), message)
    .replace(/\b(?:Bearer\s+)?(?:lin_api_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+)\b/gi, "[redacted]");
}

export function createProviderTransport(options: ProviderTransportOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  return {
    async json(url: string, init: RequestInit, context: ProviderRequestContext) {
      const secrets = await options.secrets();
      if (context.mutation) {
        let allowed = false;
        try {
          allowed = await options.allowWrites();
        } catch {
          throw new Error(`The write-permission check failed, so nothing was sent to ${context.provider}.`);
        }
        if (!allowed) {
          throw new Error(`Changes to ${context.provider} are disabled. Reads still work; enable “Allow provider changes” in Tasks settings to write.`);
        }
      }

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetchImpl(url, { ...init, signal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(redactSecrets(`${context.provider} request failed: ${message}`, secrets));
      }

      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new HttpResponseError(
          redactSecrets(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`, secrets),
          response.status,
          responseRetryAfterMs(response),
        );
      }
      if (!response.ok) {
        const record = body !== null && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        const message = typeof record.message === "string" ? record.message : response.statusText;
        throw new HttpResponseError(
          redactSecrets(`${response.status} ${message}`, secrets),
          response.status,
          responseRetryAfterMs(response),
        );
      }
      return body;
    },
  };
}
