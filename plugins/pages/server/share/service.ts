// Share a page on Here.now. Every rule that keeps content private lives here:
// placeholder first, lock and verify before real bytes, an access check before every upload,
// base-version uploads, one queue per page, and a password that stays out of every output.
import { randomBytes, randomUUID } from "node:crypto";
import type { Access, Page, Share, ShareInput } from "../../contract.js";
import { HereNowError, type HereNowClient, type RemoteAccess, type SiteFile } from "./here-now.js";
import { toShare, type ShareRow, type ShareStore } from "./store.js";

/** What Sharing needs from the core store. T1 provides it. */
export type ShareDeps = {
  getPage(pageId: string): Page | null;
  /** Final published bytes for a version: themed HTML plus the asset list to upload. */
  getPublishBundle(versionId: string): { files: Array<{ path: string; contentType: string; bytes: Buffer }> } | null;
  publishChanged(pageId: string): void;
  /** Flat Here.now folder name mirroring the page's BB project and logical folder. */
  getRemoteFolder(page: Page): Promise<string | undefined>;
};

export type ShareDefaults = { access: Access; allowedDomains: string[] };
export type ShareStatus = { configured: boolean; share: Share | null; defaults: ShareDefaults };
export type Follow = Share["follow"];

/** Access as the owner asked for it. Lists are lowercase, unique, and sorted. */
export type WantedAccess = { access: Access; allowedDomains: string[]; allowedEmails: string[] };

/** The `page-share-confirm` pending-interaction payload. It never carries a password. */
export type ShareConfirmPayload = {
  pageId: string; title: string; versionN: number;
  access: Access; allowedDomains: string[]; allowedEmails: string[];
  /** "latest", or the pinned version number. */
  follow: "latest" | number;
  url: string | null; adoptSlug: string | null;
  firstShare: boolean;
  /** True when this call makes the page readable by anyone with the link, where it was not before. */
  goesPublic: boolean;
  /** The access this call replaces (an existing share, or an adopted site), in words. Null for a new site. */
  replaces: string | null;
};

export class ShareError extends Error {
  constructor(message: string) { super(message); this.name = "ShareError"; }
}

export const NOT_CONFIGURED = "Here.now key not set. Add it in the Pages plugin settings.";
const REMOTE_MODE: Record<Access, string> = { restricted: "restricted", password: "password", link: "anyone_with_link" };
const ACCESS_WORDS: Record<Access, string> = { restricted: "restricted", password: "password", link: "anyone with the link" };

/** Appended to every uploaded index.html, so a signed-out fetch can tell whether our content is visible. */
export const versionMarker = (versionId: string) => `bb-pages-version:${versionId}`;

export const normalizeList = (values: readonly string[] | undefined) => [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

export function wanted(access: Access, allowedDomains?: readonly string[], allowedEmails?: readonly string[]): WantedAccess {
  return access === "restricted"
    ? { access, allowedDomains: normalizeList(allowedDomains), allowedEmails: normalizeList(allowedEmails) }
    : { access, allowedDomains: [], allowedEmails: [] };
}
const wantedOf = (row: ShareRow) => wanted(row.access, JSON.parse(row.allowed_domains_json) as string[], JSON.parse(row.allowed_emails_json) as string[]);

/** Mode must match; for restricted, the domain and email lists must match as sets. */
export function accessMatches(remote: RemoteAccess, want: WantedAccess): boolean {
  if (remote.mode !== REMOTE_MODE[want.access]) return false;
  if (want.access !== "restricted") return true;
  return sameList(normalizeList(remote.allowedDomains), want.allowedDomains) && sameList(normalizeList(remote.allowedEmails), want.allowedEmails);
}

export function describeAccess(want: WantedAccess): string {
  if (want.access !== "restricted") return ACCESS_WORDS[want.access];
  const who = [...want.allowedDomains, ...want.allowedEmails];
  return who.length ? `restricted to ${who.join(", ")}` : "restricted to the owner";
}
function describeRemote(remote: RemoteAccess): string {
  if (remote.mode === "anyone_with_link") return "anyone with the link";
  if (remote.mode === "restricted") return describeAccess(wanted("restricted", remote.allowedDomains, remote.allowedEmails));
  return remote.mode;
}

/** Only our own messages and Here.now's fixed messages reach users. Neither can contain a password. */
export function safeMessage(error: unknown): string {
  if (error instanceof ShareError || error instanceof HereNowError) return error.message;
  return "Sharing failed. Try again from the Share popover.";
}

function withMarker(files: SiteFile[], versionId: string): SiteFile[] {
  return files.map((file) => file.path === "index.html"
    ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from(`\n<!-- ${versionMarker(versionId)} -->\n`, "utf8")]) }
    : file);
}

export type ShareServiceOptions = {
  store: ShareStore;
  deps: ShareDeps;
  /** Null when the Here.now key is not set. */
  client(): Promise<HereNowClient | null>;
  defaults(): Promise<ShareDefaults>;
  log: { warn(message: string): void };
};

export type ShareService = {
  getShare(pageId: string): Promise<ShareStatus>;
  sharePage(input: ShareInput): Promise<Share>;
  setFollow(pageId: string, follow: Follow): Promise<Share>;
  unsharePage(pageId: string): Promise<void>;
  revealPassword(pageId: string): string;
  rotatePassword(pageId: string): Promise<Share>;
  onVersionCreated(pageId: string, versionId: string): Promise<void>;
  /** After a page is deleted: delete its site and share row. Never throws; a failure marks the row as an error and is logged. */
  onPageDeleted(pageId: string): Promise<void>;
  /** What the confirmation dialog shows for this input. Reads the remote access of an adopted site. */
  confirmPayload(input: ShareInput): Promise<ShareConfirmPayload>;
  resolveVersionN(pageId: string, n: number): string | null;
  pageIdByKey(key: string): string | null;
  /** Reconcile existing owned Sites into their BB project folders. Best effort. */
  syncFolders(): Promise<void>;
};

export function createShareService({ store, deps, client, defaults, log }: ShareServiceOptions): ShareService {
  // One queue per page: uploads and access changes for a page never overlap.
  const queues = new Map<string, Promise<unknown>>();
  function serialize<T>(pageId: string, run: () => Promise<T>): Promise<T> {
    const next = (queues.get(pageId) ?? Promise.resolve()).catch(() => undefined).then(run);
    const tail = next.catch(() => undefined);
    queues.set(pageId, tail);
    void tail.then(() => { if (queues.get(pageId) === tail) queues.delete(pageId); });
    return next;
  }

  async function requireClient() {
    const hereNow = await client();
    if (!hereNow) throw new ShareError(NOT_CONFIGURED);
    return hereNow;
  }
  function requirePage(pageId: string) {
    const page = deps.getPage(pageId);
    if (!page) throw new ShareError("Page not found.");
    return page;
  }
  function requireRow(pageId: string) {
    const row = store.get(pageId);
    if (!row) throw new ShareError("This page is not shared.");
    return row;
  }
  function targetOf(page: Page, follow: Follow) {
    if (follow === "latest") return page.currentVersionId;
    const version = store.version(follow);
    if (!version || version.page_id !== page.id) throw new ShareError("That version does not belong to this page.");
    return version.id;
  }
  const view = (pageId: string) => toShare(requireRow(pageId));
  const changed = (pageId: string) => deps.publishChanged(pageId);
  function fail(pageId: string, error: unknown) {
    if (!store.get(pageId)) return;
    store.update(pageId, { status: "error", lastError: safeMessage(error) });
    changed(pageId);
  }

  /** Set the access on Here.now. A new password is stored the moment Here.now accepts it. */
  async function applyAccess(hereNow: HereNowClient, pageId: string, slug: string, want: WantedAccess) {
    if (want.access === "password") {
      const password = randomBytes(12).toString("base64url");
      await hereNow.setPassword(slug, password);
      store.update(pageId, { password });
      return;
    }
    await hereNow.setAccess(slug, { mode: want.access === "link" ? "anyone_with_link" : "restricted", allowedDomains: want.allowedDomains, allowedEmails: want.allowedEmails });
  }

  /**
   * Read the access back, then (for private modes) fetch the site signed out and require that
   * `marker` is not in the response. `marker` is null only when the live content is not ours.
   */
  async function verifyAccess(hereNow: HereNowClient, slug: string, url: string, want: WantedAccess, marker: string | null) {
    const remote = await hereNow.getAccess(slug);
    if (!accessMatches(remote, want)) throw new ShareError(`Here.now did not confirm ${describeAccess(want)} access; it reports ${describeRemote(remote)}. Nothing new was uploaded.`);
    if (want.access !== "link" && marker && await hereNow.signedOutContains(url, marker)) {
      throw new ShareError("The site was readable while signed out. Nothing new was uploaded.");
    }
  }

  /** Upload one version. Refuses unless the remote access matches the row. Uses the recorded base version. */
  async function upload(hereNow: HereNowClient, pageId: string, versionId: string) {
    const row = requireRow(pageId);
    const want = wantedOf(row);
    const bundle = deps.getPublishBundle(versionId);
    if (!bundle) throw new ShareError("This version has no publishable HTML.");
    const files = withMarker(bundle.files, versionId);
    const remote = await hereNow.getAccess(row.slug);
    if (!accessMatches(remote, want)) {
      throw new ShareError(`Upload refused: Here.now reports ${describeRemote(remote)}, but this share is ${describeAccess(want)}. Choose the access again in the Share popover.`);
    }
    store.update(pageId, { status: "publishing", lastError: null });
    changed(pageId);
    const stage = await hereNow.updateSite(row.slug, files, row.remote_version_id, await deps.getRemoteFolder(requirePage(pageId)));
    await hereNow.upload(stage, files);
    const live = await hereNow.finalize(row.slug, stage.versionId);
    store.update(pageId, { liveVersionId: versionId, remoteVersionId: live.currentVersionId, url: live.siteUrl, status: "ready", lastError: null });
    if (want.access !== "link" && await hereNow.signedOutContains(live.siteUrl, versionMarker(versionId))) {
      throw new ShareError("The new version was readable while signed out. Check the site's access on Here.now.");
    }
    changed(pageId);
  }

  async function createSite(hereNow: HereNowClient, page: Page, want: WantedAccess, follow: Follow, target: string) {
    const marker = `bb-pages-lock:${randomUUID()}`;
    const placeholder: SiteFile[] = [{
      path: "index.html", contentType: "text/html; charset=utf-8",
      bytes: Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Preparing page</title></head><body><p>This page is being prepared.</p><!-- ${marker} --></body></html>`, "utf8"),
    }];
    const stage = await hereNow.createSite(placeholder, page.title, await deps.getRemoteFolder(page));
    await hereNow.upload(stage, placeholder);
    const live = await hereNow.finalize(stage.slug, stage.versionId);
    store.insert({ pageId: page.id, slug: live.slug, url: live.siteUrl, ...want, follow, remoteVersionId: live.currentVersionId });
    changed(page.id);
    try {
      await applyAccess(hereNow, page.id, live.slug, want);
      await verifyAccess(hereNow, live.slug, live.siteUrl, want, marker);
      await upload(hereNow, page.id, target);
    } catch (error) { fail(page.id, error); throw error; }
  }

  async function adoptSite(hereNow: HereNowClient, page: Page, slug: string, want: WantedAccess, follow: Follow, target: string) {
    if (store.bySlug(slug)) throw new ShareError("Another page already shares that site.");
    const site = await hereNow.getSite(slug);
    const remote = await hereNow.getAccess(slug);
    store.insert({ pageId: page.id, slug, url: site.siteUrl, ...want, follow, remoteVersionId: site.currentVersionId });
    changed(page.id);
    try {
      // The access changes only when the caller asked for something else. A password cannot be read
      // back, so adopting in password mode always sets a new one that the owner can copy.
      if (!accessMatches(remote, want) || want.access === "password") {
        await applyAccess(hereNow, page.id, slug, want);
        await verifyAccess(hereNow, slug, site.siteUrl, want, null);
      }
      await upload(hereNow, page.id, target);
    } catch (error) { fail(page.id, error); throw error; }
  }

  /**
   * An existing share. With `relock`, set the access again when the row or the remote differs from
   * `want`. Then make `target` live when it is not, or when the last attempt failed.
   */
  async function updateShare(hereNow: HereNowClient, row: ShareRow, want: WantedAccess, follow: Follow, target: string, relock: boolean) {
    const pageId = row.page_id;
    store.update(pageId, { follow });
    try {
      const folder = await deps.getRemoteFolder(requirePage(pageId));
      if (folder) await hereNow.setFolder(row.slug, folder);
      // wanted() builds both sides in one key order with sorted lists, so JSON equality is set equality.
      if (relock && (JSON.stringify(wantedOf(row)) !== JSON.stringify(want) || !accessMatches(await hereNow.getAccess(row.slug), want))) {
        await applyAccess(hereNow, pageId, row.slug, want);
        await verifyAccess(hereNow, row.slug, row.url, want, row.live_version_id ? versionMarker(row.live_version_id) : null);
        store.update(pageId, { ...want, ...(want.access === "password" ? {} : { password: null }) });
      }
      if (row.live_version_id !== target || row.status !== "ready") {
        // An owner retry after an error takes the site's current version as the new base.
        if (row.status === "error") store.update(pageId, { remoteVersionId: (await hereNow.getSite(row.slug)).currentVersionId });
        await upload(hereNow, pageId, target);
      } else {
        changed(pageId);
      }
    } catch (error) { fail(pageId, error); throw error; }
  }

  async function confirmPayload(input: ShareInput): Promise<ShareConfirmPayload> {
    const page = requirePage(input.pageId);
    const row = store.get(page.id);
    const want = wanted(input.access, input.allowedDomains, input.allowedEmails);
    const follow = input.follow ?? (row?.follow as Follow | undefined) ?? "latest";
    const target = targetOf(page, follow);
    const versionN = store.version(target)?.n ?? 0;
    let replaces: string | null = null;
    let wasPublic = false;
    if (row) {
      if (input.adoptSlug && input.adoptSlug !== row.slug) throw new ShareError("This page is already shared on another site. Unshare it first.");
      replaces = describeAccess(wantedOf(row));
      wasPublic = row.access === "link";
    } else if (input.adoptSlug) {
      const remote = await (await requireClient()).getAccess(input.adoptSlug);
      replaces = describeRemote(remote);
      wasPublic = remote.mode === "anyone_with_link";
    } else {
      await requireClient();
    }
    return {
      pageId: page.id, title: page.title, versionN, ...want, follow: follow === "latest" ? "latest" : versionN,
      url: row?.url ?? null, adoptSlug: input.adoptSlug ?? null, firstShare: !row,
      goesPublic: want.access === "link" && !wasPublic, replaces,
    };
  }

  function unsharePage(pageId: string) {
    return serialize(pageId, async () => {
      const row = store.get(pageId);
      if (!row) return;
      await (await requireClient()).deleteSite(row.slug);
      store.delete(pageId);
      changed(pageId);
    });
  }

  return {
    async syncFolders() {
      const hereNow = await client();
      if (!hereNow) return;
      for (const row of store.list()) {
        const page = deps.getPage(row.page_id);
        if (!page) continue;
        try {
          const folder = await deps.getRemoteFolder(page);
          if (folder) await hereNow.setFolder(row.slug, folder);
        } catch (error) {
          log.warn(`folder sync for page ${page.id} failed: ${safeMessage(error)}`);
        }
      }
    },

    async getShare(pageId) {
      const row = store.get(pageId);
      const [hereNow, shareDefaults] = await Promise.all([client(), defaults()]);
      return { configured: hereNow !== null, share: row ? toShare(row) : null, defaults: shareDefaults };
    },

    sharePage(input) {
      return serialize(input.pageId, async () => {
        const hereNow = await requireClient();
        const page = requirePage(input.pageId);
        const want = wanted(input.access, input.allowedDomains, input.allowedEmails);
        if (want.access === "restricted" && want.allowedDomains.length + want.allowedEmails.length === 0) throw new ShareError("Restricted access needs at least one domain or email.");
        const row = store.get(page.id);
        const follow = input.follow ?? (row?.follow as Follow | undefined) ?? "latest";
        const target = targetOf(page, follow);
        if (row) {
          if (input.adoptSlug && input.adoptSlug !== row.slug) throw new ShareError("This page is already shared on another site. Unshare it first.");
          await updateShare(hereNow, row, want, follow, target, true);
        } else if (input.adoptSlug) {
          await adoptSite(hereNow, page, input.adoptSlug, want, follow, target);
        } else {
          await createSite(hereNow, page, want, follow, target);
        }
        return view(page.id);
      });
    },

    setFollow(pageId, follow) {
      return serialize(pageId, async () => {
        const hereNow = await requireClient();
        const row = requireRow(pageId);
        const target = targetOf(requirePage(pageId), follow);
        await updateShare(hereNow, row, wantedOf(row), follow, target, false);
        return view(pageId);
      });
    },

    unsharePage,

    onPageDeleted(pageId) {
      return unsharePage(pageId).catch((error: unknown) => {
        fail(pageId, error);
        log.warn(`unshare after deleting page ${pageId} failed: ${safeMessage(error)}`);
      });
    },

    revealPassword(pageId) {
      const row = requireRow(pageId);
      if (row.access !== "password" || row.password === null) throw new ShareError("This share has no password.");
      return row.password;
    },

    rotatePassword(pageId) {
      return serialize(pageId, async () => {
        const hereNow = await requireClient();
        const row = requireRow(pageId);
        if (row.access !== "password") throw new ShareError("This share does not use a password.");
        try {
          await applyAccess(hereNow, pageId, row.slug, wantedOf(row));
          await verifyAccess(hereNow, row.slug, row.url, wantedOf(row), row.live_version_id ? versionMarker(row.live_version_id) : null);
        } catch (error) { fail(pageId, error); throw error; }
        changed(pageId);
        return view(pageId);
      });
    },

    onVersionCreated(pageId) {
      return serialize(pageId, async () => {
        const row = store.get(pageId);
        if (!row || row.follow !== "latest" || row.status !== "ready") return;
        const page = deps.getPage(pageId);
        if (!page || row.live_version_id === page.currentVersionId) return;
        try {
          const hereNow = await client();
          if (!hereNow) throw new ShareError(NOT_CONFIGURED);
          await upload(hereNow, pageId, page.currentVersionId);
        } catch (error) {
          fail(pageId, error);
          log.warn(`share upload for page ${pageId} stopped: ${safeMessage(error)}`);
        }
      }).catch(() => undefined);
    },

    confirmPayload,
    resolveVersionN: (pageId, n) => store.versionIdByN(pageId, n),
    pageIdByKey: (key) => store.pageIdByKey(key),
  };
}
