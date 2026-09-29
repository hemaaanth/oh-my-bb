// Here.now REST client for Pages sharing. Request shapes follow https://here.now/openapi.json.
// Errors never carry provider response bodies, the API key, or a password.
import { createHash } from "node:crypto";

export type SiteFile = { path: string; contentType: string; bytes: Buffer };
export type StagedVersion = { slug: string; siteUrl: string; versionId: string; uploads: Array<{ path: string; method: string; url: string; headers: Record<string, string> }> };
export type LiveSite = { slug: string; siteUrl: string; currentVersionId: string | null };
/** `GET /publish/:slug/access`. Allowlists are filled only in restricted mode. */
export type RemoteAccess = { mode: string; allowedDomains: string[]; allowedEmails: string[] };
export type AccessPatch = { mode: "restricted" | "anyone_with_link"; allowedDomains: string[]; allowedEmails: string[] };

export type HereNowClient = {
  createSite(files: SiteFile[], displayName: string, folder?: string): Promise<StagedVersion>;
  updateSite(slug: string, files: SiteFile[], baseVersionId: string | null, folder?: string): Promise<StagedVersion>;
  upload(stage: StagedVersion, files: SiteFile[]): Promise<void>;
  finalize(slug: string, versionId: string): Promise<LiveSite & { currentVersionId: string }>;
  getSite(slug: string): Promise<LiveSite>;
  getAccess(slug: string): Promise<RemoteAccess>;
  /** Restricted or link mode. Here.now clears any password on this call. */
  setAccess(slug: string, access: AccessPatch): Promise<void>;
  /** Password mode. Here.now clears restricted allowlists on this call. */
  setPassword(slug: string, password: string): Promise<void>;
  /** File an owned Site in a dashboard folder. A missing folder is created by Here.now. */
  setFolder(slug: string, folder: string): Promise<void>;
  deleteSite(slug: string): Promise<void>;
  /** Fetch the site as an anonymous visitor and report whether `marker` is in the response body. */
  signedOutContains(siteUrl: string, marker: string): Promise<boolean>;
};

export class HereNowError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); this.name = "HereNowError"; }
}

const TIMEOUT_MS = 30_000;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function createHereNowClient({ apiKey, baseUrl = "https://here.now", fetchImpl = (input, init) => globalThis.fetch(input, init) }: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }): HereNowClient {
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-herenow-client": "bb/pages" };
  const site = (slug: string, rest = "") => `/api/v1/publish/${encodeURIComponent(slug)}${rest}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new HereNowError("Here.now could not be reached.", 0, "network_error");
    }
    if (!response.ok) {
      let code = "provider_error";
      try { const parsed = await response.json() as { code?: unknown }; if (typeof parsed.code === "string") code = parsed.code; } catch { /* the body is never surfaced */ }
      if (response.status === 409 && code === "provider_error") code = "conflict";
      const message = code === "version_conflict"
        ? "The Here.now site changed outside Pages (version conflict)."
        : response.status === 404 ? "Here.now site not found, or this API key does not own it." : `Here.now request failed (${response.status}).`;
      throw new HereNowError(message, response.status, code);
    }
    return await response.json() as T;
  }

  const manifest = (files: SiteFile[]) => files.map((file) => ({ path: file.path, size: file.bytes.byteLength, contentType: file.contentType, hash: createHash("sha256").update(file.bytes).digest("hex") }));
  const staged = (response: { slug: string; siteUrl: string; upload: { versionId: string; uploads?: StagedVersion["uploads"] } }): StagedVersion =>
    ({ slug: response.slug, siteUrl: response.siteUrl, versionId: response.upload.versionId, uploads: response.upload.uploads ?? [] });

  return {
    async createSite(files, displayName, folder) {
      return staged(await call("POST", "/api/v1/publish", { files: manifest(files), displayName: displayName.slice(0, 80), ...(folder ? { folder } : {}) }));
    },
    async updateSite(slug, files, baseVersionId, folder) {
      return staged(await call("PUT", site(slug), { files: manifest(files), ...(baseVersionId ? { baseVersionId } : {}), ...(folder ? { folder } : {}) }));
    },
    async upload(stage, files) {
      const byPath = new Map(files.map((file) => [file.path, file]));
      for (const target of stage.uploads) {
        const file = byPath.get(target.path);
        if (!file) throw new HereNowError("Here.now asked for a file Pages did not send.", 0, "unknown_upload_path");
        let response: Response;
        try {
          response = await fetchImpl(target.url, { method: target.method || "PUT", headers: target.headers, body: new Uint8Array(file.bytes), signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch {
          throw new HereNowError("Here.now file upload could not be reached.", 0, "network_error");
        }
        if (!response.ok) throw new HereNowError(`Here.now file upload failed (${response.status}).`, response.status, "upload_failed");
      }
    },
    async finalize(slug, versionId) {
      const response = await call<{ slug: string; siteUrl: string; currentVersionId: string }>("POST", site(slug, "/finalize"), { versionId });
      return { slug: response.slug, siteUrl: response.siteUrl, currentVersionId: response.currentVersionId };
    },
    async getSite(slug) {
      const response = await call<{ slug: string; siteUrl: string; currentVersionId?: string | null }>("GET", site(slug));
      return { slug: response.slug, siteUrl: response.siteUrl, currentVersionId: response.currentVersionId ?? null };
    },
    async getAccess(slug) {
      const response = await call<{ access?: { mode?: unknown; allowedDomains?: unknown; allowedEmails?: unknown } }>("GET", site(slug, "/access"));
      return { mode: typeof response.access?.mode === "string" ? response.access.mode : "unknown", allowedDomains: strings(response.access?.allowedDomains), allowedEmails: strings(response.access?.allowedEmails) };
    },
    async setAccess(slug, access) {
      await call("PATCH", site(slug, "/access"), { ...access, notify: false });
    },
    async setPassword(slug, password) {
      await call("PATCH", site(slug, "/metadata"), { password });
    },
    async setFolder(slug, folder) {
      await call("PATCH", site(slug, "/metadata"), { folder });
    },
    async deleteSite(slug) {
      try { await call("DELETE", site(slug)); } catch (error) {
        if (error instanceof HereNowError && error.status === 404) return; // already gone
        throw error;
      }
    },
    async signedOutContains(siteUrl, marker) {
      // A fresh query string sidesteps any cached copy of the pre-lock placeholder.
      const url = new URL(siteUrl);
      url.searchParams.set("bb-check", createHash("sha256").update(`${marker}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12));
      let response: Response;
      try {
        response = await fetchImpl(url, { redirect: "manual", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new HereNowError("Here.now could not be reached for the signed-out check.", 0, "network_error");
      }
      return (await response.text()).includes(marker);
    },
  };
}
