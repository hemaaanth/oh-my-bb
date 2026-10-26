import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface TunnelHandle {
  publicUrl: string;
  reachable: Promise<void>;
  closed: Promise<void>;
  stop(): Promise<void>;
}

interface StartTunnelOptions {
  cloudflaredPath: string;
  localUrl: string;
  mode: "quick" | "custom";
  customHostname?: string;
  tunnelToken?: string;
  log(message: string): void;
  checkReachability?(url: string): Promise<void>;
}

const QUICK_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export function parseQuickTunnelUrl(output: string): string | null {
  return output.match(QUICK_URL_PATTERN)?.[0] ?? null;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  return promise;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 3_000);
  force.unref?.();
  await waitForExit(child);
  clearTimeout(force);
}

async function waitForPublicUrl(url: string, child: ChildProcess): Promise<void> {
  const hostname = new URL(url).hostname;
  const deadline = Date.now() + 45_000;
  let lastError = "DNS record not published";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("cloudflared exited before its public URL became reachable");
    }
    try {
      // Query Cloudflare DNS directly. Resolving the brand-new hostname through
      // the OS first can cache NXDOMAIN and make the owner's browser fail even
      // after Cloudflare has published the record.
      const response = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
        {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(2_000),
        },
      );
      const payload: unknown = await response.json();
      if (
        payload !== null &&
        typeof payload === "object" &&
        "Answer" in payload &&
        Array.isArray(payload.Answer) &&
        payload.Answer.length > 0
      ) {
        return;
      }
      lastError = `DNS-over-HTTPS returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250, undefined, { ref: false });
  }
  throw new Error(`public tunnel URL did not become reachable: ${lastError}`);
}

export async function startCloudflareTunnel(
  options: StartTunnelOptions,
): Promise<TunnelHandle> {
  const args =
    options.mode === "quick"
      ? ["tunnel", "--no-autoupdate", "--url", options.localUrl]
      : ["tunnel", "--no-autoupdate", "run"];
  const redact = (value: string) =>
    options.tunnelToken ? value.replaceAll(options.tunnelToken, "[token]") : value;
  const child = spawn(options.cloudflaredPath, args, {
    env: { ...process.env, TUNNEL_TOKEN: options.mode === "custom" ? options.tunnelToken : undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let pendingLog = "";
  let output = "";
  let settled = false;
  let readinessTimeout: NodeJS.Timeout | undefined;
  let connectionTimeout: NodeJS.Timeout | undefined;
  const {
    promise: connected,
    resolve: resolveConnected,
    reject: rejectConnected,
  } = Promise.withResolvers<void>();
  void connected.catch(() => undefined);
  const { promise: published, resolve, reject } = Promise.withResolvers<string>();
  const fail = (error: Error) => {
    rejectConnected(error);
    clearTimeout(readinessTimeout);
    clearTimeout(connectionTimeout);
    if (settled) return;
    settled = true;
    reject(error);
  };
  const succeed = (url: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(readinessTimeout);
    resolve(url.replace(/\/$/, ""));
  };
  const consume = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output = (output + text).slice(-16_384);
    pendingLog += text;
    const lines = pendingLog.split("\n");
    pendingLog = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) options.log(redact(trimmed));
    }
    if (pendingLog.length > 16_384) pendingLog = pendingLog.slice(-16_384);
    if (/registered tunnel connection/i.test(output)) {
      clearTimeout(connectionTimeout);
      resolveConnected();
    }
    if (options.mode === "quick") {
      const url = parseQuickTunnelUrl(output);
      if (url) succeed(url);
    } else if (/registered tunnel connection/i.test(output)) {
      succeed(`https://${options.customHostname}`);
    }
  };

  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  child.once("error", (error) => {
    const message =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `cloudflared was not found at ${options.cloudflaredPath}`
        : `cloudflared failed to start: ${error.message}`;
    fail(new Error(message));
  });
  child.once("exit", (code, signal) => {
    fail(
      new Error(
        `cloudflared exited before the tunnel was ready (${signal ?? `code ${code ?? "unknown"}`})${output.trim() ? `: ${redact(output).trim().slice(-800)}` : ""}`,
      ),
    );
  });
  readinessTimeout = setTimeout(
    () =>
      fail(
        new Error(
          options.mode === "quick"
            ? "cloudflared did not publish a tunnel URL within 30 seconds"
            : "cloudflared did not establish the named tunnel within 30 seconds",
        ),
      ),
    30_000,
  );
  readinessTimeout.unref?.();
  connectionTimeout = setTimeout(
    () =>
      rejectConnected(
        new Error("cloudflared did not register a tunnel connection within 30 seconds"),
      ),
    30_000,
  );
  connectionTimeout.unref?.();

  try {
    const publicUrl = await published;
    const reachable = (async () => {
      await connected;
      if (!options.checkReachability) {
        // Let Cloudflare publish the generated record before the first lookup;
        // an early NXDOMAIN can otherwise be cached by the owner's resolver.
        await delay(3_000, undefined, { ref: false });
      }
      await (
        options.checkReachability ??
        ((value: string) => waitForPublicUrl(value, child))
      )(publicUrl);
    })();
    return {
      closed: waitForExit(child),
      publicUrl,
      reachable,
      stop: () => stopChild(child),
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}
