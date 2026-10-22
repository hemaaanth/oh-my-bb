import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { browserExtensionZip, browserExtensionOrigin } from "./browser-extension-download.js";
import { cookieState } from "./browser-cookies.js";
import { syncBrowserCookies } from "./browser-sync.js";
import type { TrustedBrowserSettings } from "./trusted-browser.js";

const MAX_BYTES = 5 * 1024 * 1024;
const CONNECTION = "browser-cookie-connection";
const PENDING = "browser-cookie-pairing";
export const browserCookieStatusSchema = z.object({
  paired: z.boolean(), lastSyncAt: z.number().nullable(), cookies: z.number(),
  skippedPartitioned: z.number(), localImported: z.boolean().nullable(),
});
const recordSchema = browserCookieStatusSchema.omit({ paired: true }).extend({ tokenHash: z.string() });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const matches = (value: string, expected: string) => timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(expected, "hex"));

export const browserCookieRpcContract = defineRpcContract({
  browserCookieStatus: { input: z.null(), output: browserCookieStatusSchema },
  beginBrowserCookiePairing: { input: z.null(), output: z.object({ code: z.string(), serverUrl: z.string(), extensionZip: z.string(), expiresAt: z.number() }) },
  disconnectBrowserCookies: { input: z.null(), output: z.null() },
});

export class BrowserCookieConnection {
  readonly stateFile: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private bb: BbPluginApi, private directory: string, private importLocal = syncBrowserCookies) {
    this.stateFile = join(directory, "state.json");
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action);
    this.pending = next.catch(() => undefined);
    return next;
  }
  importLegacy(legacy: { connection: unknown; pairing: unknown; state: string | null }) {
    return this.serial(async () => {
      if (await this.bb.storage.kv.get("browser-owner-v1") || await this.bb.storage.kv.get("legacy-imported-v1")) return false;
      const resuming = await this.bb.storage.kv.get("legacy-adopting-v1");
      let existingState = false; try { await readFile(this.stateFile); existingState = true; } catch {}
      if (!resuming && (await this.record() || await this.bb.storage.kv.get(PENDING) || existingState)) return false;
      await this.bb.storage.kv.set("legacy-adopting-v1", true);
      if (legacy.state !== null) {
        if (Buffer.byteLength(legacy.state) > MAX_BYTES) throw new Error("Legacy browser seed is too large");
        await mkdir(this.directory, {recursive:true,mode:0o700}); await chmod(this.directory,0o700);
        const temporary=this.stateFile+'.migration'; await writeFile(temporary,legacy.state,{mode:0o600});await chmod(temporary,0o600);await rename(temporary,this.stateFile);
      }
      if(legacy.connection)await this.bb.storage.kv.set(CONNECTION,recordSchema.parse(legacy.connection));
      if(legacy.pairing)await this.bb.storage.kv.set(PENDING,z.object({hash:z.string(),expiresAt:z.number()}).parse(legacy.pairing));
      await this.bb.storage.kv.set("legacy-imported-v1",true);await this.bb.storage.kv.delete("legacy-adopting-v1");return true;
    });
  }
  private async record() {
    const record = await this.bb.storage.kv.get(CONNECTION);
    return record === undefined || record === null ? null : recordSchema.parse(record);
  }
  async authorized(token: string) {
    const record = await this.record();
    return record !== null && matches(token, record.tokenHash);
  }
  async status() {
    const record = await this.record();
    return { paired: record !== null, lastSyncAt: record?.lastSyncAt ?? null, cookies: record?.cookies ?? 0,
      skippedPartitioned: record?.skippedPartitioned ?? 0, localImported: record?.localImported ?? null };
  }
  async settings<T extends TrustedBrowserSettings>(settings: T): Promise<T> {
    return (await this.record())?.lastSyncAt ? { ...settings, browserStateFile: this.stateFile } : settings;
  }
  beginPairing() {
    return this.serial(async () => {
      await this.bb.storage.kv.set("browser-owner-v1",true);
      const code = randomBytes(24).toString("base64url");
      const expiresAt = Date.now() + 10 * 60_000;
      await this.bb.storage.kv.set(PENDING, { hash: hash(code), expiresAt });
      const serverUrl = this.bb.server.experimental_appUrl || this.bb.server.loopbackBaseUrl;
      return { code, expiresAt, serverUrl, extensionZip: (await browserExtensionZip()).toString("base64") };
    });
  }
  pair(code: string) {
    return this.serial(async () => {
      const raw = await this.bb.storage.kv.get(PENDING);
      const pending = z.object({ hash: z.string(), expiresAt: z.number() }).safeParse(raw);
      if (!pending.success || pending.data.expiresAt < Date.now() || !matches(code, pending.data.hash)) return null;
      await this.bb.storage.kv.delete(PENDING);
      const token = randomBytes(32).toString("base64url");
      await rm(this.stateFile, { force: true });
      await this.bb.storage.kv.set(CONNECTION, { tokenHash: hash(token), lastSyncAt: null, cookies: 0, skippedPartitioned: 0, localImported: null });
      this.bb.realtime.publish("browser-cookies", {});
      return { token };
    });
  }
  disconnect() {
    return this.serial(async () => {
      await this.bb.storage.kv.set("browser-owner-v1",true);
      await this.bb.storage.kv.delete(PENDING);
      await this.bb.storage.kv.delete(CONNECTION);
      await rm(this.stateFile, { force: true });
      this.bb.realtime.publish("browser-cookies", {});
      return null;
    });
  }
  snapshot(token: string, message: unknown) {
    return this.serial(async () => {
      const record = await this.record();
      if (!record || !matches(token, record.tokenHash)) return null;
      const state = cookieState(message);
      const text = `${JSON.stringify(state)}\n`;
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Snapshot too large");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      let previous = "";
      try { previous = await readFile(this.stateFile, "utf8"); } catch {}
      if (previous !== text) {
        const temporary = `${this.stateFile}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, this.stateFile);
      }
      // Export and sandbox delivery work even when the local CLI is older or absent.
      const local = await this.importLocal(text, AbortSignal.timeout(5000)).catch(() => ({ ok: false }));
      await this.bb.storage.kv.set(CONNECTION, { ...record, lastSyncAt: Date.now(), cookies: state.cookies.length,
        skippedPartitioned: state.skippedPartitioned, localImported: local.ok });
      this.bb.realtime.publish("browser-cookies", {});
      return { ok: true, cookies: state.cookies.length, skippedPartitioned: state.skippedPartitioned };
    });
  }
  async register() {
    const extensionOrigin = await browserExtensionOrigin();
    this.bb.rpc.register(browserCookieRpcContract, {
      browserCookieStatus: () => this.status(), beginBrowserCookiePairing: () => this.beginPairing(), disconnectBrowserCookies: () => this.disconnect(),
    });
    // These routes authenticate a pairing code or a snapshot-only bearer token.
    for (const path of ["/cookie-sync/pair", "/cookie-sync/snapshot"]) {
      const cors = (c: { header: (name: string, value: string) => unknown }) => {
        c.header("Access-Control-Allow-Origin", extensionOrigin);
        c.header("Access-Control-Allow-Headers", "authorization,content-type");
        c.header("Access-Control-Allow-Methods", "POST,OPTIONS");
        c.header("Cache-Control", "no-store");
      };
      this.bb.http.route("OPTIONS", path, (c) => { cors(c); return c.body(null, 204); }, { auth: "none" });
      this.bb.http.route("POST", path, async (c) => {
        cors(c);
        const origin = c.req.header("origin");
        if (origin && origin !== extensionOrigin) return c.json({ error: "Extension origin required" }, 403);
        if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "JSON required" }, 415);
        const token = c.req.header("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
        if (path.endsWith("/snapshot") && (!token || !await this.authorized(token))) return c.json({ error: "Pair this extension with BB first" }, 401);
        const reader = c.req.raw.body?.getReader();
        if (!reader) return c.json({ error: "Invalid request" }, 400);
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > (path.endsWith("/pair") ? 4096 : MAX_BYTES)) { await reader.cancel(); return c.json({ error: "Request too large" }, 413); }
            chunks.push(value);
          }
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (path.endsWith("/pair")) {
            const input = z.object({ code: z.string().min(32).max(128) }).strict().safeParse(body);
            const paired = input.success ? await this.pair(input.data.code) : null;
            return paired ? c.json(paired) : c.json({ error: "Pairing code is invalid or expired" }, 401);
          }
          const result = await this.snapshot(token!, body);
          return result ? c.json(result) : c.json({ error: "Connection revoked; pair with BB again" }, 401);
        } catch { return c.json({ error: "Cookie sync failed; send a valid cookie snapshot" }, 400); }
      }, { auth: "none" });
    }
  }
}
