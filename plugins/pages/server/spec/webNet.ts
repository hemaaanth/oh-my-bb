// The spec lookups' one way onto the network: GET over https to public addresses only. Every
// redirect hop is checked again, and the address check runs inside the connection's own DNS
// lookup, so the checked address is the connected one (no DNS-rebinding window). Bodies are
// capped, requests time out, and failures are values with a short reason.
// Ported from GenUI web/net.ts, web/address.ts and web/image.ts (Apache-2.0).
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { Agent, request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** Names this plugin to every service, as their usage policies ask. */
export const USER_AGENT = "bb-pages/0.5.0 (+https://github.com/hemaaanth/oh-my-bb)";
const MAX_REDIRECTS = 3;
const IDLE_MS = 8_000;

const PRIVATE_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
// IPv6 only inside global unicast (2000::/3), minus Teredo/ORCHID, documentation and 6to4.
const SPECIAL_V6: readonly (readonly [string, number])[] = [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]];
const privateV4 = new BlockList();
for (const [network, prefix] of PRIVATE_V4) privateV4.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
for (const [network, prefix] of SPECIAL_V6) specialV6.addSubnet(network, prefix, "ipv6");

/** True only for a literal IP address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  if (bare.includes("%")) return false; // zone indexes only exist on link-local addresses
  const family = isIP(bare);
  if (family === 4) return !privateV4.check(bare, "ipv4");
  if (family === 6) return globalV6.check(bare, "ipv6") && !specialV6.check(bare, "ipv6");
  return false;
}

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const startsWith = (body: Uint8Array, bytes: readonly number[], at = 0) => body.length >= at + bytes.length && bytes.every((byte, i) => body[at + i] === byte);
const SVG_START = /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i;

/** The image type `body` really holds, from its leading bytes; a Content-Type is only a claim. */
export function sniffImage(body: Uint8Array): ImageMime | null {
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(body, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(body, ascii("GIF87a")) || startsWith(body, ascii("GIF89a"))) return "image/gif";
  if (startsWith(body, ascii("RIFF")) && startsWith(body, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(body, ascii("ftyp"), 4) && (startsWith(body, ascii("avif"), 8) || startsWith(body, ascii("avis"), 8))) return "image/avif";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(body.subarray(0, 4096)).replace(/^﻿/, "").trimStart();
  return SVG_START.test(head) ? "image/svg+xml" : null;
}

/** True when a Content-Type header names an image type (parameters ignored). */
export function declaresImage(contentType: string | undefined): boolean {
  return contentType !== undefined && /^image\/[a-z0-9.+-]+\s*(;|$)/i.test(contentType.trim());
}

export interface GetOptions {
  readonly accept: string;
  readonly maxBytes: number;
  /** Deadline for the whole request, redirects included. */
  readonly timeoutMs: number;
  /** When set, the request and every redirect must stay on these hosts. */
  readonly hosts?: ReadonlySet<string>;
}

export type Fetched = { readonly ok: true; readonly url: string; readonly headers: IncomingHttpHeaders; readonly body: Buffer } | { readonly ok: false; readonly error: string };

class Refused extends Error {}

const publicLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error);
    if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) return callback(new Refused(`${hostname} is not on the public internet`));
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}) as unknown as LookupFunction;

const agent = new Agent({ keepAlive: true, maxSockets: 6, lookup: publicLookup });

/** Why `url` may not be fetched, or null when it may. */
export function refusal(url: URL, hosts?: ReadonlySet<string>): string | null {
  if (url.protocol !== "https:") return "only https links can be fetched";
  if (url.username !== "" || url.password !== "") return "links with credentials can't be fetched";
  if (url.port !== "") return "only the standard https port is allowed";
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (host === "") return "the link has no host";
  if (hosts && !hosts.has(host)) return `${host} is not an allowed host`;
  if (isIP(host) !== 0 && !isPublicAddress(host)) return `${host} is not on the public internet`;
  return null;
}

function failure(cause: unknown, deadline: AbortSignal): string {
  if (deadline.aborted) return "the request timed out";
  if (cause instanceof Refused) return cause.message;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the host could not be found";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") return "the host could not be reached";
  if (code.startsWith("ERR_TLS") || code.includes("CERT")) return "the host's certificate was not accepted";
  return cause instanceof Error ? cause.message : String(cause);
}

/** Undoes a Content-Encoding sent despite `Accept-Encoding: identity`, within the size cap. */
function decode(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const options = { maxOutputLength: maxBytes };
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "": case "identity": return body;
    case "gzip": case "x-gzip": return gunzipSync(body, options);
    case "deflate": return inflateSync(body, options);
    case "br": return brotliDecompressSync(body, options);
    default: throw new Error(`unsupported content encoding ${encoding}`);
  }
}

type Hop = { kind: "redirect"; location: string | undefined } | { kind: "done"; headers: IncomingHttpHeaders; body: Buffer } | { kind: "failed"; error: string };

function hop(url: URL, options: GetOptions, deadline: AbortSignal): Promise<Hop> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: Hop) => { if (!settled) { settled = true; resolve(result); } };
    const tooLarge = `the response is over the ${Math.round(options.maxBytes / 1024 / 1024) || 1} MB limit`;
    const req = request(url, { method: "GET", agent, lookup: publicLookup, signal: deadline, timeout: IDLE_MS, headers: { "user-agent": USER_AGENT, accept: options.accept, "accept-encoding": "identity" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); return settle({ kind: "redirect", location: res.headers.location }); }
      if (status !== 200) { res.resume(); return settle({ kind: "failed", error: `the server answered ${status}` }); }
      if (Number(res.headers["content-length"]) > options.maxBytes) { res.destroy(); return settle({ kind: "failed", error: tooLarge }); }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) { res.destroy(); settle({ kind: "failed", error: tooLarge }); } else chunks.push(chunk);
      });
      res.on("end", () => {
        try { settle({ kind: "done", headers: res.headers, body: decode(Buffer.concat(chunks), res.headers["content-encoding"], options.maxBytes) }); } catch (cause) { settle({ kind: "failed", error: failure(cause, deadline) }); }
      });
      res.on("error", (cause) => settle({ kind: "failed", error: failure(cause, deadline) }));
      res.on("close", () => settle({ kind: "failed", error: "the connection closed early" }));
    });
    req.on("timeout", () => req.destroy(new Error("the host stopped responding")));
    req.on("error", (cause) => settle({ kind: "failed", error: failure(cause, deadline) }));
    req.end();
  });
}

/** GETs `input` under the rules above. */
export async function safeGet(input: string, options: GetOptions): Promise<Fetched> {
  let url: URL;
  try { url = new URL(input); } catch { return { ok: false, error: "the link is not a valid URL" }; }
  const deadline = AbortSignal.timeout(options.timeoutMs);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const refused = refusal(url, options.hosts);
    if (refused !== null) return { ok: false, error: refused };
    const result = await hop(url, options, deadline);
    if (result.kind === "failed") return { ok: false, error: result.error };
    if (result.kind === "done") return { ok: true, url: url.href, headers: result.headers, body: result.body };
    if (result.location === undefined) return { ok: false, error: "a redirect had no destination" };
    try { url = new URL(result.location, url); } catch { return { ok: false, error: "a redirect pointed at an invalid URL" }; }
  }
  return { ok: false, error: "too many redirects" };
}
