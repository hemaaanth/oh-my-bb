// Test-only in-memory Here.now, served through a fetch stand-in. It follows the openapi shapes the
// client uses and records every call in order, so tests can check what went up before what.

type Pending = { expected: Set<string>; uploaded: Map<string, Buffer> };
export type FakeSite = {
  slug: string; siteUrl: string; mode: string; allowedDomains: string[]; allowedEmails: string[]; password: string | null;
  current: string | null; folder: string | null; live: Map<string, Buffer>; pending: Map<string, Pending>; versions: number;
};
/** One recorded call. `mode` is the site's access mode at the time of the call. */
export type FakeEvent = { type: "create" | "update" | "upload" | "finalize" | "get" | "getAccess" | "setAccess" | "setPassword" | "setFolder" | "delete" | "signedOut"; slug: string; mode: string; path?: string; text?: string; body?: unknown; password?: string };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeHereNow {
  readonly sites = new Map<string, FakeSite>();
  readonly events: FakeEvent[] = [];
  /** Accept access and password changes but do not apply them (a broken lock). */
  ignoreLock = false;
  /** Serve content to signed-out visitors whatever the mode. */
  leakSignedOut = false;
  private count = 0;

  /** Seed an existing site the key owns (for adopt). */
  seed(slug: string, access: { mode: string; allowedDomains?: string[]; allowedEmails?: string[] }, html = "<p>existing report</p>") {
    const site: FakeSite = { slug, siteUrl: `https://${slug}.here.now/`, mode: access.mode, allowedDomains: access.allowedDomains ?? [], allowedEmails: access.allowedEmails ?? [], password: null, current: `${slug}-v0`, folder: null, live: new Map([["index.html", Buffer.from(html)]]), pending: new Map(), versions: 0 };
    this.sites.set(slug, site);
    return site;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const bodyText = typeof init.body === "string" ? init.body : init.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "";
    if (url.host === "upload.fake") return this.upload(url, init.body as Uint8Array);
    if (url.host.endsWith(".here.now")) return this.visit(url);
    if (url.host !== "here.now") throw new TypeError(`unexpected host ${url.host}`);
    if ((init.headers as Record<string, string> | undefined)?.authorization !== "Bearer test-key") return json(401, { code: "unauthorized" });
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
    const parts = url.pathname.replace(/^\/api\/v1\/publish\/?/u, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 0 && method === "POST") return this.stage(null, body);
    const site = this.sites.get(parts[0] ?? "");
    if (!site) return json(404, { code: "not_found" });
    const record = (type: FakeEvent["type"], extra: Partial<FakeEvent> = {}) => this.events.push({ type, slug: site.slug, mode: site.mode, ...extra });
    const sub = parts[1] ?? "";
    if (sub === "" && method === "GET") { record("get"); return json(200, { slug: site.slug, siteUrl: site.siteUrl, currentVersionId: site.current }); }
    if (sub === "" && method === "PUT") {
      if ((body.baseVersionId ?? null) !== site.current) { record("update", { body: "conflict" }); return json(409, { code: "version_conflict" }); }
      return this.stage(site, body);
    }
    if (sub === "" && method === "DELETE") { record("delete"); this.sites.delete(site.slug); return json(200, { success: true }); }
    if (sub === "finalize" && method === "POST") {
      const pending = site.pending.get(String(body.versionId));
      if (!pending || [...pending.expected].some((path) => !pending.uploaded.has(path))) return json(400, { code: "incomplete" });
      site.live = new Map([...site.live].filter(([path]) => pending.expected.has(path)).concat([...pending.uploaded]));
      site.current = String(body.versionId);
      record("finalize");
      return json(200, { success: true, slug: site.slug, siteUrl: site.siteUrl, currentVersionId: site.current });
    }
    if (sub === "access" && method === "GET") {
      record("getAccess");
      return json(200, { access: { mode: site.mode, accessPolicyVersion: 1, allowedDomains: site.mode === "restricted" ? site.allowedDomains : [], allowedEmails: site.mode === "restricted" ? site.allowedEmails : [] } });
    }
    if (sub === "access" && method === "PATCH") {
      record("setAccess", { body });
      if (!this.ignoreLock) Object.assign(site, { mode: body.mode, allowedDomains: body.allowedDomains ?? [], allowedEmails: body.allowedEmails ?? [], password: null });
      return json(200, { access: { mode: site.mode } });
    }
    if (sub === "metadata" && method === "PATCH") {
      if (typeof body.folder === "string") {
        record("setFolder", { body });
        site.folder = body.folder;
        return json(200, { success: true, folder: { name: site.folder } });
      }
      record("setPassword", { password: typeof body.password === "string" ? body.password : undefined });
      if (!this.ignoreLock && typeof body.password === "string") Object.assign(site, { mode: "password", password: body.password, allowedDomains: [], allowedEmails: [] });
      return json(200, { success: true, passwordProtected: site.mode === "password" });
    }
    return json(404, { code: "no_route" });
  };

  private stage(existing: FakeSite | null, body: Record<string, unknown>) {
    let site = existing;
    if (!site) {
      const slug = `site-${++this.count}`;
      site = { slug, siteUrl: `https://${slug}.here.now/`, mode: "anyone_with_link", allowedDomains: [], allowedEmails: [], password: null, current: null, folder: null, live: new Map(), pending: new Map(), versions: 0 };
      this.sites.set(slug, site);
    }
    if (typeof body.folder === "string") site.folder = body.folder;
    this.events.push({ type: existing ? "update" : "create", slug: site.slug, mode: site.mode, body });
    const versionId = `${site.slug}-v${++site.versions}`;
    const files = (body.files as Array<{ path: string }>) ?? [];
    site.pending.set(versionId, { expected: new Set(files.map((file) => file.path)), uploaded: new Map() });
    return json(200, {
      slug: site.slug, siteUrl: site.siteUrl, status: "pending", isLive: false, requiresFinalize: true,
      upload: { versionId, uploads: files.map((file) => ({ path: file.path, method: "PUT", url: `https://upload.fake/${site.slug}/${versionId}/${file.path}`, headers: {} })), finalizeUrl: "", expiresInSeconds: 60 },
    });
  }

  private upload(url: URL, bytes: Uint8Array) {
    const [slug = "", versionId = "", ...rest] = url.pathname.split("/").filter(Boolean);
    const site = this.sites.get(slug);
    const pending = site?.pending.get(versionId);
    if (!site || !pending) return new Response("", { status: 404 });
    const path = rest.join("/");
    pending.uploaded.set(path, Buffer.from(bytes));
    this.events.push({ type: "upload", slug, mode: site.mode, path, text: path === "index.html" ? Buffer.from(bytes).toString("utf8") : undefined });
    return new Response("", { status: 200 });
  }

  private visit(url: URL) {
    const site = [...this.sites.values()].find((candidate) => new URL(candidate.siteUrl).host === url.host);
    if (!site) return new Response("gone", { status: 404 });
    this.events.push({ type: "signedOut", slug: site.slug, mode: site.mode });
    if (site.mode === "anyone_with_link" || this.leakSignedOut) return new Response(site.live.get("index.html")?.toString("utf8") ?? "", { status: 200 });
    return new Response("<html><body>Sign in or enter the password</body></html>", { status: 401 });
  }
}
