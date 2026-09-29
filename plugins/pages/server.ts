import path from "node:path";
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { REALTIME_CHANNEL, rpcContract } from "./contract.js";
import { PAGE_MIGRATIONS } from "./migrations.js";
import { injectPage, readPageAsset } from "./render/index.js";
import { registerPagesCli } from "./cli.js";
import { registerRoutes } from "./server/http.js";
import { importLegacyArtifacts } from "./server/import.js";
import { createPageService } from "./server/service.js";
import { registerShare, type ShareDeps } from "./server/share/index.js";
import { createPageStore } from "./server/store.js";
import { registerTools } from "./server/tools.js";

/** The core (T1) half of the RPC contract. Share methods are registered by server/share (T4). */
export const coreRpcContract = defineRpcContract({
  publishFile: rpcContract.publishFile,
  publishDocument: rpcContract.publishDocument,
  getPage: rpcContract.getPage,
  findPage: rpcContract.findPage,
  resolveFile: rpcContract.resolveFile,
  listPages: rpcContract.listPages,
  listFolders: rpcContract.listFolders,
  renamePage: rpcContract.renamePage,
  deletePage: rpcContract.deletePage,
  runProducerAction: rpcContract.runProducerAction,
});

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...PAGE_MIGRATIONS]);
  const store = createPageStore(db);

  // `sourceKey` lets a live ::inline-vis card refresh only when its own file becomes (or changes) a page.
  const publishChanged = (pageId: string, versionId?: string) => {
    const sourceKey = store.rawPage(pageId)?.page.sourceKey ?? null;
    bb.realtime.publish(REALTIME_CHANNEL, { pageId, ...(versionId ? { versionId } : {}), ...(sourceKey ? { sourceKey } : {}) });
  };
  const shareDeps: ShareDeps = {
    getPage: (pageId) => store.livePage(pageId),
    getPublishBundle: (versionId) => {
      const stored = store.storedHtml(versionId);
      if (!stored) return null;
      const assets = ["theme.css", "inter.roman.var.woff2", ...(stored.hasCharts ? ["charts.js"] as const : [])] as const;
      return {
        files: [
          { path: "index.html", contentType: "text/html; charset=utf-8", bytes: Buffer.from(injectPage(stored.html, { assetBase: "./", theme: null, hasCharts: stored.hasCharts }), "utf8") },
          ...assets.map((name) => { const asset = readPageAsset(name); return { path: `_page/${name}`, contentType: asset.contentType, bytes: asset.bytes }; }),
        ],
      };
    },
    publishChanged: (pageId) => publishChanged(pageId),
    getRemoteFolder: async (page) => {
      if (!page.projectId) return undefined;
      const project = await bb.sdk.projects.get({ projectId: page.projectId }).catch(() => null);
      if (!project) return undefined;
      const full = `${project.name}${page.folderPath ? ` / ${page.folderPath}` : ""}`;
      if (full.length <= 60) return full;
      return `${full.slice(0, 51).trimEnd()}-${createHash("sha256").update(full).digest("hex").slice(0, 8)}`;
    },
  };
  const share = registerShare(bb, shareDeps);

  const service = createPageService({
    sdk: bb.sdk,
    store,
    changed: publishChanged,
    pageDeleted: (pageId) => share.onPageDeleted(pageId),
    versionCreated: (pageId, versionId) => {
      share.onVersionCreated(pageId, versionId).catch((error: unknown) => {
        bb.log.warn(`share update failed for page ${pageId} version ${versionId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });

  bb.rpc.register(coreRpcContract, {
    publishFile: async (input) => (await service.publishFile(input)).result,
    publishDocument: (input) => service.publishDocument(input).result,
    getPage: ({ pageId, versionId }) => service.getPage(pageId, versionId),
    findPage: (ref) => service.findPage(ref),
    resolveFile: (input) => service.resolveFile(input),
    listPages: (input) => service.listPages(input),
    listFolders: ({ projectId }) => ({ folders: service.listFolders(projectId) }),
    renamePage: ({ pageId, title }) => service.renamePage(pageId, title),
    deletePage: ({ pageId }) => service.deletePage(pageId),
    runProducerAction: (input) => service.runProducerAction(input),
  });
  registerRoutes(bb, store);
  registerTools(bb, service);
  // BB allows one bb.cli.register per plugin, so share commands (T4) join the `bb pages` CLI here.
  registerPagesCli(bb, service, store, share.cliCommands);

  try {
    // Open the old database with the host's own better-sqlite3 build; the plugin bundles no native module.
    const Sqlite = db.constructor as new (file: string, options: Database.Options) => Database.Database;
    importLegacyArtifacts({
      db, store,
      legacyPath: path.join(bb.server.experimental_dataDir, "plugins", "artifacts", "data.db"),
      open: (file) => new Sqlite(file, { readonly: true, fileMustExist: true }),
      log: bb.log,
    });
  } catch (error) {
    bb.log.warn(`artifacts import failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  bb.log.info("loaded");
}
