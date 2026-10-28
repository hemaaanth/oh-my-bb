import { randomBytes } from "node:crypto";
import { init, parse } from "es-module-lexer";
import { PREVIEW_SANDBOX } from "./protocol";
export const PREVIEW_TTL_MS = 30 * 60_000;
export const PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export type PreviewSession = {
  token: string;
  threadId: string;
  origin: string;
  viewerOrigin: string;
  hostId: string | null;
  expiresAt: number;
  resourceOrigins: Set<string>;
};

/** Capabilities read one selected preview origin, never BB RPC or feedback state. */
export class PreviewSessions {
  private sessions = new Map<string, PreviewSession>();

  create(input: Omit<PreviewSession, "token" | "expiresAt" | "resourceOrigins">, now = Date.now()): PreviewSession {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
    if (this.sessions.size >= 64) throw new Error("Too many active previews. Close an old preview or wait for it to expire.");
    const session: PreviewSession = { ...input, token: randomBytes(32).toString("hex"), expiresAt: now + PREVIEW_TTL_MS, resourceOrigins: new Set() };
    this.sessions.set(session.token, session);
    return session;
  }

  get(token: string, now = Date.now()): PreviewSession | null {
    const session = this.sessions.get(token);
    return session && session.expiresAt > now ? session : null;
  }

  renew(threadId: string, origin: string, now = Date.now()): void {
    for (const session of this.sessions.values()) {
      if (session.expiresAt > now && session.threadId === threadId && session.origin === origin) session.expiresAt = now + PREVIEW_TTL_MS;
    }
  }

  clear(): void { this.sessions.clear(); }
}

export function assertPreviewUrl(target: URL, origin: string): void {
  // URL accepts some host characters that CSP treats as policy syntax.
  const literalHost = /^(?:[a-z0-9._-]+|\[[a-f0-9:.]+\])$/i.test(target.hostname);
  if (!/^https?:$/.test(target.protocol) || !literalHost || target.username || target.password || target.origin !== origin) {
    throw new Error("This preview is limited to its selected website. Open a different website explicitly in Pinpoint.");
  }
}

export function previewResourceUrl(base: string, target: URL): string {
  return base.includes("?token=")
    ? `${base}&path=${encodeURIComponent(target.pathname + target.search)}${target.hash}`
    : `${base}${target.pathname}${target.search}${target.hash}`;
}

export function previewHeaders(session: Pick<PreviewSession, "origin" | "resourceOrigins">, base: string): Record<string, string> {
  const resourceBase = base.split("?")[0]!;
  const resources = [resourceBase, session.origin, ...session.resourceOrigins].join(" ");
  return {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      `sandbox ${PREVIEW_SANDBOX}`,
      `default-src ${resources} data: blob:`,
      `script-src ${resources} 'unsafe-inline' 'unsafe-eval' blob:`,
      `style-src ${resources} 'unsafe-inline'`,
      `connect-src ${resourceBase} ${session.origin} data: blob:`,
      `form-action ${session.origin} ${resourceBase}`,
      `frame-src ${resourceBase} ${session.origin} blob:`,
      "object-src 'none'",
      `base-uri ${session.origin}`,
    ].join("; "),
  };
}

/** Declared third-party assets may load, but never add a BB app origin to CSP. */
export function collectResourceOrigins(html: string, session: Pick<PreviewSession, "resourceOrigins">, protectedOrigins: ReadonlySet<string>): void {
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
    try {
      const url = new URL(match[0]);
      assertPreviewUrl(url, url.origin);
      if (!protectedOrigins.has(url.origin) && session.resourceOrigins.size < 64) {
        session.resourceOrigins.add(url.origin);
      }
    } catch { /* Not a resource URL. */ }
  }
}

/** Preserve native relative module resolution under the capability's path. */
export async function rewritePreviewModules(source: string, target: URL, base: string): Promise<string> {
  await init;
  const [imports] = parse(source);
  for (let i = imports.length - 1; i >= 0; i -= 1) {
    const item = imports[i]!;
    if (item.d === -2) continue; // import.meta.url already points at the scoped resource.
    if (item.d >= 0) {
      // Replace only the call prefix. Nested imports and the optional second
      // argument keep their original spans and evaluation order.
      const prefix = `globalThis.__pinpointImport(${JSON.stringify(target.href).replace(/</g, "\\u003c")},`;
      source = source.slice(0, item.ss) + prefix + source.slice(item.d + 1);
    } else if (item.n && /^(?:[./]|https?:)/.test(item.n)) {
      const url = new URL(item.n, target);
      if (url.origin === target.origin) {
        source = source.slice(0, item.s - 1) + JSON.stringify(previewResourceUrl(base, url)).replace(/</g, "\\u003c") + source.slice(item.e + 1);
      }
    }
  }
  return source;
}

/** Inline modules use the original document URL, not the BB wrapper's URL. */
export async function rewritePreviewHtmlModules(html: string, target: URL, base: string): Promise<string> {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const isType = (attributes: string, type: string) =>
    new RegExp(`\\btype\\s*=\\s*(?:"${type}"|'${type}'|${type}(?:\\s|$))`, "i").test(attributes);
  const mapUrl = (value: string) => {
    const url = new URL(value, target);
    return url.origin === target.origin ? previewResourceUrl(base, url) : value;
  };
  const mapImports = (entries: Record<string, string>) => Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      /^(?:[./]|https?:)/.test(key) ? mapUrl(key) : key, mapUrl(value),
    ]),
  );
  for (let i = scripts.length - 1; i >= 0; i -= 1) {
    const script = scripts[i]!;
    let content = script[2]!;
    if (isType(script[1]!, "module")) content = await rewritePreviewModules(content, target, base);
    else if (isType(script[1]!, "importmap")) {
      const map = JSON.parse(content) as {
        imports?: Record<string, string>; scopes?: Record<string, Record<string, string>>;
      };
      if (map.imports) map.imports = mapImports(map.imports);
      if (map.scopes) map.scopes = Object.fromEntries(
        Object.entries(map.scopes).map(([scope, imports]) => [mapUrl(scope), mapImports(imports)]),
      );
      content = JSON.stringify(map);
    } else continue;
    content = content.replace(/<\/script/gi, "<\\/script");
    const start = script.index! + script[0].indexOf(">") + 1;
    html = html.slice(0, start) + content + html.slice(start + script[2]!.length);
  }
  return html;
}

export async function readPreviewBody(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > PREVIEW_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Preview resource exceeds 32 MiB.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PREVIEW_MAX_BYTES) throw new Error("Preview resource exceeds 32 MiB.");
      chunks.push(value);
    }
  } catch (cause) { await reader.cancel(); throw cause; }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
