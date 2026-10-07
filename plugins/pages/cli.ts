// `bb pages …`. The calling thread comes from the CLI context (`ctx.threadId`),
// which the bb CLI fills from the invoking agent's BB_THREAD_ID.
import { PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError, cliCommand, defineCli, type BbPluginApi, type PluginCliCommand, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { directive } from "./contract.js";
import { FileSourceError, mapCliPath } from "./server/files.js";
import { PageInputError, type PageService } from "./server/service.js";
import { StaleVersionError, type PageStore } from "./server/store.js";
import { lookupView, publishSummary } from "./server/tools.js";

/** Extra `bb pages` commands contributed by other modules (T4 adds `share`, `unshare`). Keys are invocation paths. */
export type PagesCliCommands = Record<string, PluginCliCommand>;

const json = { json: { type: "boolean", description: "Emit machine-readable JSON" } } as const;
const pageSelector = {
  key: { type: "string", description: "Select the page by its stable key instead of an id", placeholder: "NAME" },
  "producer-key": { type: "string", description: "Select a document page by its producer key", placeholder: "KEY" },
} as const;

const ok = (value: unknown, human: string, asJson: boolean | undefined): PluginCliResult => ({ exitCode: 0, stdout: asJson ? JSON.stringify(value, null, 2) : human });

async function attempt(run: () => Promise<PluginCliResult> | PluginCliResult): Promise<PluginCliResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    if (error instanceof FileSourceError || error instanceof PageInputError) throw new PluginCliError(error.message, { code: "invalid_input" });
    if (error instanceof StaleVersionError) throw new PluginCliError(error.message, { code: "stale_version" });
    throw error;
  }
}

function callingThread(ctx: PluginCliContext): string {
  if (ctx.threadId) return ctx.threadId;
  throw new PluginCliError("Run this command from a BB thread. The thread id is unknown.", { code: "thread_required", hint: "Agents in a BB thread have BB_THREAD_ID set; run `bb pages publish` from there." });
}

export function registerPagesCli(bb: BbPluginApi, service: PageService, store: PageStore, extra: PagesCliCommands = {}) {
  const select = (id: string | undefined, options: { key?: string; "producer-key"?: string }) => {
    const given = [id, options.key, options["producer-key"]].filter(Boolean).length;
    if (given !== 1) throw new PluginCliError("Pass exactly one of: a page id, --key, or --producer-key.", { code: "invalid_selector" });
    const detail = service.findPage({ pageId: id, key: options.key, producerKey: options["producer-key"] });
    if (!detail) throw new PluginCliError("Page not found.", { code: "not_found" });
    return detail;
  };

  bb.cli.register(defineCli({
    name: "pages",
    summary: "Publish, list, and read versioned pages",
    description: "A page is a versioned HTML page made from an .html or .md file. Publishing the same file, --key, or --page again adds a version.",
    commands: {
      publish: cliCommand({
        summary: "Publish an .html or .md file as a page",
        description: "The file must be inside the calling thread's workspace or thread storage ($BB_THREAD_STORAGE). Unchanged bytes add no version.",
        positionals: [{ name: "file", description: "Absolute path, or a path relative to the current directory", required: true }],
        options: {
          title: { type: "string", description: "Page title (default: <title>, first <h1>, or the file name)", placeholder: "TEXT" },
          label: { type: "string", description: "Short note for this version", placeholder: "TEXT" },
          folder: { type: "string", description: "Logical subfolder inside this BB project, e.g. Reports/Weekly", placeholder: "PATH" },
          key: { type: "string", description: "Stable page name, e.g. boost-daily. Keeps one page across runs and threads", placeholder: "NAME" },
          page: { type: "string", description: "Add a version to this page id", placeholder: "PAGE_ID" },
          display: { type: "enum", values: ["card", "inline"] as const, description: "How the returned directive shows the page in chat (default: card)" },
          ...json,
        },
        constraints: [{ kind: "at-most-one", options: ["key", "page"] }],
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const threadId = callingThread(ctx);
            const { source, file } = await mapCliPath(bb.sdk, threadId, positionals.file, ctx.cwd);
            const published = await service.publishFile({ threadId, file, source, title: options.title, label: options.label, folder: options.folder, key: options.key, pageId: options.page });
            const result = { ...published.result, directive: directive(published.result.page.id, published.result.version.id, options.display) };
            return ok({ ...result, changed: published.changed }, publishSummary(published, options.display), options.json);
          });
        },
      }),
      list: cliCommand({
        summary: "List pages, newest first (50 per page)",
        options: {
          project: { type: "string", description: "Only pages of this project id", placeholder: "PROJECT_ID" },
          offset: { type: "integer", min: 0, max: 1_000_000, default: 0, description: "Skip this many pages" },
          ...json,
        },
        run({ options }) {
          const listed = service.listPages({ offset: options.offset, projectId: options.project });
          const human = listed.pages.map(({ page, version, share }) => `${page.id}  v${version.n}  ${page.updatedAt.slice(0, 16).replace("T", " ")}  ${page.folderPath ? `${page.folderPath}/` : ""}${page.title}${share ? `  [shared: ${share.access}]` : ""}`).join("\n");
          return ok(listed, (human || "No pages.") + (listed.nextOffset === null ? "" : `\nMore: --offset ${listed.nextOffset}`), options.json);
        },
      }),
      get: cliCommand({
        summary: "Show one page",
        positionals: [{ name: "id", description: "Page id" }],
        options: { ...pageSelector, ...json },
        run({ positionals, options }) {
          const detail = select(positionals.id, options);
          const view = lookupView(detail);
          const human = [`${detail.page.title}`, `id: ${detail.page.id}`, `kind: ${detail.page.kind}`, `version: v${detail.version.n} (${detail.version.id})`, detail.page.sourceKey ? `source: ${detail.page.sourceKey}` : null, detail.share ? `shared: ${detail.share.url} (${detail.share.access}, ${detail.share.status})` : "shared: no", view.directive].filter(Boolean).join("\n");
          return ok(view, human, options.json);
        },
      }),
      versions: cliCommand({
        summary: "List a page's versions, newest first",
        positionals: [{ name: "id", description: "Page id" }],
        options: { ...pageSelector, ...json },
        run({ positionals, options }) {
          const detail = select(positionals.id, options);
          const human = detail.versions.map((version) => `v${version.n}  ${version.id}  ${version.createdAt.slice(0, 16).replace("T", " ")}${version.label ? `  ${version.label}` : ""}${version.id === detail.page.currentVersionId ? "  (current)" : ""}`).join("\n");
          return ok(detail.versions, human, options.json);
        },
      }),
      pull: cliCommand({
        summary: "Print a page version's stored HTML to stdout",
        positionals: [{ name: "id", description: "Page id" }],
        options: { ...pageSelector, version: { type: "integer", min: 1, max: 1_000_000, description: "Version number (default: current)" } },
        run({ positionals, options }) {
          const detail = select(positionals.id, options);
          const versionId = options.version === undefined ? detail.page.currentVersionId : store.versionIdByN(detail.page.id, options.version);
          const stored = versionId ? store.storedHtml(versionId) : null;
          if (!stored) throw new PluginCliError(`Version ${options.version} not found.`, { code: "not_found" });
          if (Buffer.byteLength(stored.html, "utf8") > PLUGIN_CLI_OUTPUT_MAX_BYTES) throw new PluginCliError(`This version is larger than the CLI output limit (${PLUGIN_CLI_OUTPUT_MAX_BYTES} bytes).`, { code: "output_too_large" });
          return { exitCode: 0, stdout: stored.html };
        },
      }),
      ...extra,
    },
  }));
}
