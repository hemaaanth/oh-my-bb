import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { Share } from "../../contract.js";
import { PAGE_MIGRATIONS } from "../../migrations.js";
import { createPageStore } from "../store.js";
import { pagesHost, storageOf } from "../test-fakes.js";
import { FakeHereNow, type FakeEvent } from "./fake-here-now.js";
import { registerShare } from "./index.js";
import { createShareStore } from "./store.js";

type Published = { page: { id: string }; version: { id: string; n: number } };
type Host = ReturnType<typeof pagesHost>;
const html = (body: string) => `<!doctype html><html><head><title>T1 hello</title></head><body><p>${body}</p></body></html>`;
const FILE = `${storageOf("thr_a")}/t1/hello.html`;

let host: Host | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  await host?.harness.lifecycle.dispose();
  host = null;
});

async function setup({ key = true }: { key?: boolean } = {}) {
  const fake = new FakeHereNow();
  vi.stubGlobal("fetch", fake.fetch);
  host = pagesHost();
  const { harness, files } = host;
  if (key) await harness.behavior.setSettings({ hereNowApiKey: "test-key" });
  const rpc = <T>(method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<T>;
  const publish = async (body: string, extra: Record<string, unknown> = {}) => {
    files.set(FILE, html(body));
    return rpc<Published>("publishFile", { threadId: "thr_a", file: "t1/hello.html", source: "thread-storage", ...extra });
  };
  const first = await publish("BODY-ONE");
  const share = (input: Record<string, unknown>) => rpc<Share>("sharePage", { pageId: first.page.id, ...input });
  const status = () => rpc<{ configured: boolean; share: Share | null; defaults: { access: string; allowedDomains: string[] } }>("getShare", { pageId: first.page.id });
  return { fake, harness, rpc, publish, first, share, status };
}

/** Index of the first upload whose index.html contains `text`, or -1. */
const firstUploadOf = (events: FakeEvent[], text: string) => events.findIndex((event) => event.type === "upload" && event.text?.includes(text));

/** Answer the newest pending confirmation once it appears. */
async function answer(harness: Host["harness"], value: unknown, seen = 0) {
  await vi.waitFor(() => expect(harness.inspection.pendingInteractions.length).toBeGreaterThan(seen));
  const pending = harness.inspection.pendingInteractions.at(-1)!;
  harness.behavior.submitInteraction(pending.id, value as never);
  return pending;
}

describe("the placeholder rule", () => {
  it("uploads real bytes only after the lock is set, read back, and checked signed out", async () => {
    const { fake, share } = await setup();
    const shared = await share({ access: "password" });
    expect(shared).toMatchObject({ access: "password", hasPassword: true, status: "ready", follow: "latest", lastError: null });

    const events = fake.events.filter((event) => event.slug === shared.slug);
    const real = firstUploadOf(events, "BODY-ONE");
    expect(real).toBeGreaterThan(0);
    const before = events.slice(0, real).map((event) => event.type);
    expect(before.slice(0, 3)).toEqual(["create", "upload", "finalize"]); // the placeholder
    expect(events[1]!.text).toContain("This page is being prepared.");
    const lock = before.indexOf("setPassword");
    expect(lock).toBeGreaterThan(2);
    expect(before.indexOf("getAccess", lock)).toBeGreaterThan(lock);
    expect(before.indexOf("signedOut", lock)).toBeGreaterThan(lock);
    expect(events.filter((event) => event.type === "upload" && event.text?.includes("BODY-ONE")).every((event) => event.mode === "password")).toBe(true);
  });

  it("uploads nothing real when Here.now does not apply the lock", async () => {
    const { fake, share, status } = await setup();
    fake.ignoreLock = true;
    await expect(share({ access: "restricted", allowedDomains: ["example.com"] })).rejects.toThrow(/did not confirm restricted to example.com access/u);
    expect(firstUploadOf(fake.events, "BODY-ONE")).toBe(-1);
    expect((await status()).share).toMatchObject({ status: "error", liveVersionId: null });
  });

  it("uploads nothing real when the placeholder is readable signed out", async () => {
    const { fake, share, status } = await setup();
    fake.leakSignedOut = true;
    await expect(share({ access: "password" })).rejects.toThrow(/readable while signed out/u);
    expect(firstUploadOf(fake.events, "BODY-ONE")).toBe(-1);
    expect((await status()).share?.lastError).toMatch(/readable while signed out/u);
  });
});

describe("access modes", () => {
  it("files a shared page under its project and logical folder", async () => {
    const { fake, publish, share } = await setup();
    await publish("BODY-ONE", { folder: "Reports / Weekly" });
    const shared = await share({ access: "password" });
    expect(fake.sites.get(shared.slug)?.folder).toBe("Test Project / Reports/Weekly");
  });

  it("sets, verifies, and stores restricted, password, and link access", async () => {
    const { fake, share, rpc, first } = await setup();
    const restricted = await share({ access: "restricted", allowedDomains: ["Example.com", "example.com"], allowedEmails: ["Ana@Example.com"] });
    expect(restricted).toMatchObject({ access: "restricted", allowedDomains: ["example.com"], allowedEmails: ["ana@example.com"], hasPassword: false, status: "ready" });
    expect(fake.sites.get(restricted.slug)).toMatchObject({ mode: "restricted", allowedDomains: ["example.com"], allowedEmails: ["ana@example.com"] });

    const password = await share({ access: "password" });
    expect(password).toMatchObject({ slug: restricted.slug, access: "password", allowedDomains: [], hasPassword: true, status: "ready" });
    const site = fake.sites.get(password.slug)!;
    expect(site.mode).toBe("password");
    expect(await rpc("revealPassword", { pageId: first.page.id })).toEqual({ password: site.password });

    const link = await share({ access: "link" });
    expect(link).toMatchObject({ access: "link", hasPassword: false, status: "ready" });
    expect(site.mode).toBe("anyone_with_link");
    await expect(rpc("revealPassword", { pageId: first.page.id })).rejects.toThrow(/no password/u);
  });

  it("rotates the password and stores the new one", async () => {
    const { fake, share, rpc, first } = await setup();
    const shared = await share({ access: "password" });
    const before = fake.sites.get(shared.slug)!.password;
    await rpc("rotatePassword", { pageId: first.page.id });
    const after = fake.sites.get(shared.slug)!.password;
    expect(after).not.toBe(before);
    expect(await rpc("revealPassword", { pageId: first.page.id })).toEqual({ password: after });
  });

  it("reports a missing key and the default access", async () => {
    const { share, status, harness } = await setup({ key: false });
    await harness.behavior.setSettings({ defaultAccess: "restricted", defaultAllowedDomains: "example.com, bad domain, Example.org" });
    expect(await status()).toEqual({ configured: false, share: null, defaults: { access: "restricted", allowedDomains: ["example.com", "example.org"] } });
    await expect(share({ access: "password" })).rejects.toThrow("Here.now key not set");
  });
});

describe("folder reconciliation", () => {
  it("files existing shared sites when the plugin starts", async () => {
    const fake = new FakeHereNow();
    vi.stubGlobal("fetch", fake.fetch);
    fake.seed("existing-site", { mode: "password" });
    const { bb, harness } = createFakePluginHost({ pluginId: "pages", settings: { hereNowApiKey: "test-key" } });
    const db = bb.storage.database();
    bb.storage.migrate(db, [...PAGE_MIGRATIONS]);
    const pages = createPageStore(db);
    const { pageId } = pages.createPage(
      { title: "Existing", kind: "file", projectId: "proj_test", folderPath: "Reports", sourceKey: null, producer: null, producerKey: null },
      { label: null, html: "<p>x</p>", sha256: "x", hasCharts: false, document: null, provenance: null, sourcePath: null, threadId: null },
    );
    createShareStore(db).insert({ pageId, slug: "existing-site", url: "https://existing-site.here.now/", access: "password", allowedDomains: [], allowedEmails: [], follow: "latest", remoteVersionId: "existing-site-v0" });
    registerShare(bb, {
      getPage: (id) => pages.livePage(id),
      getPublishBundle: () => null,
      publishChanged: () => undefined,
      getRemoteFolder: async () => "Test Project / Reports",
    });
    await vi.waitFor(() => expect(fake.sites.get("existing-site")?.folder).toBe("Test Project / Reports"));
    await harness.lifecycle.dispose();
  });
});

describe("follow latest", () => {
  it("uploads a new version by itself, and stops when pinned", async () => {
    const { fake, share, publish, rpc, first } = await setup();
    const shared = await share({ access: "password" });
    const second = await publish("BODY-TWO");
    await vi.waitFor(() => expect(fake.sites.get(shared.slug)!.live.get("index.html")!.toString()).toContain("BODY-TWO"));
    await vi.waitFor(async () => expect((await rpc<{ share: Share }>("getShare", { pageId: first.page.id })).share).toMatchObject({ liveVersionId: second.version.id, status: "ready" }));

    const pinned = await rpc<Share>("setFollow", { pageId: first.page.id, follow: first.version.id });
    expect(pinned).toMatchObject({ follow: first.version.id, liveVersionId: first.version.id });
    const site = fake.sites.get(shared.slug)!.live.get("index.html")!.toString();
    expect(site).toContain("BODY-ONE");
    // The frame bridge is for BB previews only. A shared site never talks to a parent window.
    expect(site).not.toContain("bb-pages:");
    expect(site).not.toContain("data-bb-frame");
    await publish("BODY-THREE");
    // setFollow queues behind the version hook, so the hook has run when it returns.
    await rpc("setFollow", { pageId: first.page.id, follow: first.version.id });
    expect(firstUploadOf(fake.events, "BODY-THREE")).toBe(-1);

    const latest = await rpc<Share>("setFollow", { pageId: first.page.id, follow: "latest" });
    expect(latest.follow).toBe("latest");
    expect(fake.sites.get(shared.slug)!.live.get("index.html")!.toString()).toContain("BODY-THREE");
  });

  it("refuses to upload when the remote access no longer matches", async () => {
    const { fake, share, publish, status } = await setup();
    const shared = await share({ access: "password" });
    fake.sites.get(shared.slug)!.mode = "anyone_with_link"; // someone opened it on Here.now
    await publish("BODY-TWO");
    await vi.waitFor(async () => expect((await status()).share).toMatchObject({ status: "error", lastError: expect.stringMatching(/^Upload refused: Here.now reports anyone with the link, but this share is password/u) }));
    expect(firstUploadOf(fake.events, "BODY-TWO")).toBe(-1);
    expect(fake.sites.get(shared.slug)!.mode).toBe("anyone_with_link");
  });

  it("turns a version conflict into an error, without retrying", async () => {
    const { fake, share, publish, status, rpc, first } = await setup();
    const shared = await share({ access: "password" });
    fake.sites.get(shared.slug)!.current = "changed-elsewhere";
    await publish("BODY-TWO");
    await vi.waitFor(async () => expect((await status()).share).toMatchObject({ status: "error", lastError: expect.stringContaining("version conflict") }));
    await publish("BODY-THREE");
    await rpc("getShare", { pageId: first.page.id });
    await vi.waitFor(() => expect(fake.events.filter((event) => event.type === "update" && event.body === "conflict")).toHaveLength(1));
    expect(firstUploadOf(fake.events, "BODY-THREE")).toBe(-1);
  });
});

describe("adopt", () => {
  it("keeps the site's access when it already matches, and uploads through the normal checks", async () => {
    const { fake, publish, harness } = await setup();
    const keyed = await publish("WEEKLY-REPORT", { key: "weekly-report" });
    fake.seed("adopt-me", { mode: "restricted", allowedDomains: ["example.com"] });
    const result = await harness.behavior.runCli(["share", "--key", "weekly-report", "--adopt", "adopt-me", "--access", "restricted", "--domain", "example.com", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pageId: keyed.page.id, slug: "adopt-me", url: "https://adopt-me.here.now/", access: "restricted", allowedDomains: ["example.com"], status: "ready" });
    const events = fake.events.filter((event) => event.slug === "adopt-me");
    expect(events.some((event) => event.type === "setAccess" || event.type === "setPassword")).toBe(false);
    const real = firstUploadOf(events, "WEEKLY-REPORT");
    expect(real).toBeGreaterThan(events.findIndex((event) => event.type === "getAccess"));
    expect(events[real]!.mode).toBe("restricted");
    expect(fake.sites.get("adopt-me")!.mode).toBe("restricted");
  });

  it("changes the access only to what the caller asked for, before any upload", async () => {
    const { fake, share } = await setup();
    fake.seed("open-site", { mode: "anyone_with_link" });
    const shared = await share({ access: "restricted", allowedEmails: ["ana@example.com"], adoptSlug: "open-site" });
    expect(shared).toMatchObject({ slug: "open-site", access: "restricted", allowedEmails: ["ana@example.com"] });
    const events = fake.events.filter((event) => event.slug === "open-site");
    expect(events.findIndex((event) => event.type === "setAccess")).toBeLessThan(firstUploadOf(events, "BODY-ONE"));
    expect(fake.sites.get("open-site")!).toMatchObject({ mode: "restricted", allowedEmails: ["ana@example.com"] });
  });
});

describe("confirmation", () => {
  it("page_share asks in the thread and returns only the share summary", async () => {
    const { fake, harness, first } = await setup();
    const call = harness.behavior.callAgentTool("page_share", { pageId: first.page.id, access: "restricted", allowedDomains: ["example.com"] }, { threadId: "thr_a" });
    const pending = await answer(harness, { confirmed: true });
    expect(pending).toMatchObject({ threadId: "thr_a", rendererId: "page-share-confirm" });
    expect(pending.payload).toMatchObject({ title: "T1 hello", versionN: 1, access: "restricted", allowedDomains: ["example.com"], follow: "latest", firstShare: true, goesPublic: false });
    const result = JSON.parse(String(await call));
    expect(Object.keys(result).sort()).toEqual(["access", "follow", "shared", "url"]);
    expect(result).toEqual({ shared: true, url: expect.stringMatching(/^https:\/\/site-1\.here\.now/u), access: "restricted", follow: "latest" });
    expect(fake.sites.size).toBe(1);
  });

  it("creates nothing when the user cancels, and flags going public", async () => {
    const { fake, harness, share, first } = await setup();
    await share({ access: "password" });
    const call = harness.behavior.callAgentTool("page_share", { pageId: first.page.id, access: "link" }, { threadId: "thr_a" });
    const pending = await answer(harness, { confirmed: false });
    expect(pending.payload).toMatchObject({ access: "link", goesPublic: true, firstShare: false, replaces: "password" });
    expect(JSON.parse(String(await call))).toMatchObject({ shared: false });
    expect([...fake.sites.values()][0]!.mode).toBe("password");
  });

  it("the CLI asks when it runs in a thread and runs directly without one", async () => {
    const { fake, harness, first } = await setup();
    const inThread = harness.behavior.runCli(["share", first.page.id, "--access", "password"], { threadId: "thr_a" });
    await answer(harness, { confirmed: false });
    expect(await inThread).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Cancelled") });
    expect(fake.sites.size).toBe(0);

    const direct = await harness.behavior.runCli(["share", first.page.id, "--access", "password"]);
    expect(direct.exitCode).toBe(0);
    expect(direct.stdout).toContain("access: password");
    expect(harness.inspection.pendingInteractions.length).toBeLessThanOrEqual(1);
  });
});

describe("password safety", () => {
  it("never puts the password in share output, tool output, CLI output, logs, realtime, or errors", async () => {
    const { fake, harness, rpc, share, publish, first, status } = await setup();
    const outputs: unknown[] = [];
    const tool = harness.behavior.callAgentTool("page_share", { pageId: first.page.id, access: "password" }, { threadId: "thr_a" });
    await answer(harness, { confirmed: true });
    outputs.push(await tool);
    const slug = [...fake.sites.keys()][0]!;
    outputs.push(await status(), await share({ access: "password" }), await rpc("getPage", { pageId: first.page.id }), await rpc("listPages", {}));
    outputs.push(await rpc("rotatePassword", { pageId: first.page.id }));
    outputs.push(await harness.behavior.runCli(["share-status", first.page.id]), await harness.behavior.runCli(["share-status", first.page.id, "--json"]));
    outputs.push(await harness.behavior.runCli(["share", first.page.id, "--access", "password", "--json"]));
    outputs.push(String(await harness.behavior.callAgentTool("page_lookup", { pageId: first.page.id }, { threadId: "thr_a" })));
    // Errors: a refused upload and a failed rotation.
    fake.sites.get(slug)!.mode = "anyone_with_link";
    await publish("BODY-TWO");
    await vi.waitFor(async () => expect((await status()).share?.status).toBe("error"));
    fake.ignoreLock = true;
    outputs.push(await rpc("rotatePassword", { pageId: first.page.id }).catch((error: unknown) => (error as Error).message));
    outputs.push(await harness.behavior.runCli(["share", first.page.id, "--access", "password"]));
    outputs.push(await status());

    const haystack = JSON.stringify([outputs, harness.inspection.logEntries, harness.inspection.realtimeSignals, harness.inspection.pendingInteractions]);
    // Every password Pages ever sent to Here.now.
    const passwords = new Set(fake.events.flatMap((event) => event.password ? [event.password] : []));
    expect(passwords.size).toBeGreaterThanOrEqual(3);
    for (const password of passwords) expect(haystack.includes(password)).toBe(false);
    // The owner can still copy the stored password.
    expect(passwords.has((await rpc<{ password: string }>("revealPassword", { pageId: first.page.id })).password)).toBe(true);
  });
});

describe("unshare", () => {
  it("deletes the Here.now site and the share row", async () => {
    const { fake, harness, share, status, first } = await setup();
    const shared = await share({ access: "password" });
    const result = await harness.behavior.runCli(["unshare", first.page.id]);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(fake.sites.has(shared.slug)).toBe(false);
    expect(fake.events.at(-1)).toMatchObject({ type: "delete", slug: shared.slug });
    expect((await status()).share).toBeNull();
  });
});

describe("onPageDeleted", () => {
  // T1 calls the hook, so this host wires registerShare directly to hold the returned registration.
  async function shareHost() {
    const fake = new FakeHereNow();
    vi.stubGlobal("fetch", fake.fetch);
    const { bb, harness } = createFakePluginHost({ pluginId: "pages", settings: { hereNowApiKey: "test-key" } });
    const db = bb.storage.database();
    bb.storage.migrate(db, [...PAGE_MIGRATIONS]);
    const store = createPageStore(db);
    const share = registerShare(bb, {
      getPage: (pageId) => store.livePage(pageId),
      getPublishBundle: (versionId) => ({ files: [{ path: "index.html", contentType: "text/html", bytes: Buffer.from(`<p>${versionId}</p>`) }] }),
      publishChanged: () => undefined,
      getRemoteFolder: async () => undefined,
    });
    const { pageId } = store.createPage(
      { title: "Doomed", kind: "file", projectId: null, sourceKey: null, producer: null, producerKey: null },
      { label: null, html: "<p>x</p>", sha256: "x", hasCharts: false, document: null, provenance: null, sourcePath: null, threadId: null },
    );
    const shared = await harness.behavior.callRpc("sharePage", { pageId, access: "password" }) as Share;
    return { fake, harness, share, pageId, shared, cleanup: () => harness.lifecycle.dispose() };
  }

  it("deletes the site and the row, and does nothing for an unshared page", async () => {
    const { fake, harness, share, pageId, shared, cleanup } = await shareHost();
    await share.onPageDeleted(pageId);
    expect(fake.sites.has(shared.slug)).toBe(false);
    expect(await harness.behavior.callRpc("getShare", { pageId })).toMatchObject({ share: null });
    const before = fake.events.length;
    await share.onPageDeleted(pageId);
    expect(fake.events.length).toBe(before);
    await cleanup();
  });

  it("never throws: a failure keeps the row as an error and logs it without the password", async () => {
    const { fake, harness, share, pageId, shared, cleanup } = await shareHost();
    const password = fake.sites.get(shared.slug)!.password!;
    await harness.behavior.setSettings({ hereNowApiKey: null });
    await expect(share.onPageDeleted(pageId)).resolves.toBeUndefined();
    expect(fake.sites.has(shared.slug)).toBe(true);
    expect(await harness.behavior.callRpc("getShare", { pageId })).toMatchObject({ share: { status: "error", lastError: expect.stringContaining("Here.now key not set") } });
    const warning = harness.inspection.logEntries.find((entry) => JSON.stringify(entry).includes("unshare after deleting page"));
    expect(warning).toBeTruthy();
    expect(JSON.stringify(harness.inspection.logEntries)).not.toContain(password);
    await cleanup();
  });
});
