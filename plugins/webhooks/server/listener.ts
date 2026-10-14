// Optional loopback listener: POST /webhook/<endpoint-id>, nothing else.
// A tunnel (for example a Cloudflare named tunnel) can point a public path at this
// port instead of the BB server, so the internet never reaches the BB API.
// Each request goes to the same deliver handler as the BB route, with the same checks.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export const LISTENER_PATH_PREFIX = "/webhook/";
const LISTENER_PATH = /^\/webhook\/(wh_[a-f0-9]{24})$/;
const NOT_FOUND = JSON.stringify({ ok: false, error: "not found" });

/** "" turns the listener off. Otherwise a port from 1024 to 65535. */
export function parseListenerPort(value: string | null | undefined): number | null | "invalid" {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (!/^\d{4,5}$/.test(trimmed)) return "invalid";
  const port = Number(trimmed);
  return port >= 1024 && port <= 65535 ? port : "invalid";
}

export type Listener = { port: number; close: () => Promise<void> };

export async function startListener(options: {
  port: number;
  handle: (request: Request, endpointId: string) => Promise<Response>;
  onError: (reason: string) => void;
}): Promise<Listener> {
  const server = createServer((req, res) => {
    void serve(req, res, options).catch((error) => {
      options.onError(error instanceof Error ? error.name : "error");
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "internal error" }));
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : options.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * Starts the listener without blocking the caller, and retries while the port is
 * busy. On a plugin reload the new copy can start before the old copy closes it.
 */
export function keepListening(options: {
  port: number;
  handle: (request: Request, endpointId: string) => Promise<Response>;
  onError: (reason: string) => void;
  onListening: (port: number) => void;
  onGiveUp: (reason: string) => void;
  retryMs?: number;
  attempts?: number;
}): { close: () => Promise<void> } {
  const retryMs = options.retryMs ?? 500;
  const attempts = options.attempts ?? 40;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: Listener | undefined;
  const attempt = (left: number) => {
    startListener(options).then(
      (started) => {
        if (closed) return void started.close();
        listener = started;
        options.onListening(started.port);
      },
      (error) => {
        if (closed) return;
        const busy = (error as NodeJS.ErrnoException)?.code === "EADDRINUSE";
        if (busy && left > 1) timer = setTimeout(() => attempt(left - 1), retryMs);
        else options.onGiveUp(error instanceof Error ? error.message : String(error));
      },
    );
  };
  attempt(attempts);
  return {
    close: async () => {
      closed = true;
      clearTimeout(timer);
      await listener?.close();
    },
  };
}

async function serve(req: IncomingMessage, res: ServerResponse, options: { handle: (request: Request, endpointId: string) => Promise<Response> }) {
  const path = (req.url ?? "").split("?")[0];
  const match = LISTENER_PATH.exec(path);
  if (req.method !== "POST" || !match) {
    req.resume();
    res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(NOT_FOUND);
    return;
  }
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    // Cookies are never used, so they are not passed on.
    if (name !== "cookie") headers.append(name, req.rawHeaders[index + 1]);
  }
  // The deliver handler reads the stream with its own per-endpoint size limit.
  const request = new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers,
    body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    duplex: "half",
  } as RequestInit);
  const response = await options.handle(request, match[1]);
  const body = Buffer.from(await response.arrayBuffer());
  // A rejected body (too large, unknown endpoint) is left unread. Close the
  // connection after the answer instead of reading the rest.
  const unread = !req.complete;
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => (out[name] = value));
  if (unread) out.connection = "close";
  res.writeHead(response.status, out);
  res.end(body, () => {
    if (unread) req.destroy();
  });
}
