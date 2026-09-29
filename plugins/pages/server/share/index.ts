// Sharing (T4): settings, share RPC methods, the page_share tool, and `bb pages share|unshare|share-status`.
import { PluginCliError, cliCommand, defineRpcContract, type BbPluginApi, type PluginCliCommand, type PluginCliResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accessSchema, rpcContract, shareInputSchema, type Access, type Share, type ShareInput } from "../../contract.js";
import { HereNowError, createHereNowClient } from "./here-now.js";
import { NOT_CONFIGURED, ShareError, createShareService, describeAccess, safeMessage, wanted, type ShareConfirmPayload, type ShareDeps } from "./service.js";
import { createShareStore } from "./store.js";

export type { ShareDeps } from "./service.js";

export type ShareRegistration = {
  /** Called by T1 after every new version. Uploads it when the share follows latest. */
  onVersionCreated(pageId: string, versionId: string): Promise<void>;
  /** Call after a page is deleted. Deletes its Here.now site and share row when one exists. Never throws. */
  onPageDeleted(pageId: string): Promise<void>;
  /** Extra `bb pages <name>` subcommands. BB allows one bb.cli.register per plugin, so T1 merges these into `bb pages`. */
  cliCommands: Record<string, PluginCliCommand>;
};

/** Renderer id of the confirmation the page_share tool and the in-thread CLI open. app/share registers it. */
export const CONFIRM_RENDERER_ID = "page-share-confirm";

export const shareRpcContract = defineRpcContract({
  getShare: rpcContract.getShare,
  sharePage: rpcContract.sharePage,
  setFollow: rpcContract.setFollow,
  unsharePage: rpcContract.unsharePage,
  revealPassword: rpcContract.revealPassword,
  rotatePassword: rpcContract.rotatePassword,
});

const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/u;
const ACCESS_VALUES = ["restricted", "password", "link"] as const satisfies readonly Access[];

/** Only ShareError and HereNowError text reaches callers. Anything else becomes a fixed message. */
async function guarded<T>(log: BbPluginApi["log"], run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ShareError || error instanceof HereNowError) throw new ShareError(error.message);
    log.warn(`share request failed: ${error instanceof Error ? error.name : "unknown error"}`);
    throw new ShareError(safeMessage(error));
  }
}

/** Human text for a share. Never includes the password. */
function describeShare(share: Share, versionN: number | null): string {
  return [
    `url: ${share.url}`,
    `access: ${describeAccess(wanted(share.access, share.allowedDomains, share.allowedEmails))}`,
    `version: ${share.follow === "latest" ? "latest (follows new versions)" : `pinned${versionN ? ` to v${versionN}` : ""}`}`,
    `status: ${share.status}${share.lastError ? ` (${share.lastError})` : ""}`,
  ].join("\n");
}

export function registerShare(bb: BbPluginApi, deps: ShareDeps): ShareRegistration {
  const settings = bb.settings.define({
    hereNowApiKey: { type: "string", label: "Here.now API key", description: "Used only by the Pages server to create and update shared sites.", secret: true },
    defaultAccess: { type: "select", label: "Default access", description: "Access for a new share started with the Share button.", options: [...ACCESS_VALUES], default: "password" },
    defaultAllowedDomains: { type: "string", label: "Default allowed domains", description: "Comma-separated, e.g. example.com. Fills Restricted access in the Share popover.", default: "" },
  });

  const store = createShareStore(bb.storage.database());
  store.markInterrupted();
  const service = createShareService({
    store, deps, log: bb.log,
    async client() {
      const apiKey = ((await settings.get()).hereNowApiKey ?? "").trim();
      return apiKey ? createHereNowClient({ apiKey }) : null;
    },
    async defaults() {
      const values = await settings.get();
      const access = ACCESS_VALUES.find((value) => value === values.defaultAccess) ?? "password";
      const allowedDomains = [...new Set(values.defaultAllowedDomains.split(",").map((value) => value.trim().toLowerCase()).filter((value) => DOMAIN.test(value)))];
      return { access, allowedDomains };
    },
  });
  void service.syncFolders().catch((error: unknown) => bb.log.warn(`folder sync failed: ${safeMessage(error)}`));

  bb.rpc.register(shareRpcContract, {
    getShare: ({ pageId }) => guarded(bb.log, () => service.getShare(pageId)),
    sharePage: (input) => guarded(bb.log, () => service.sharePage(input)),
    setFollow: ({ pageId, follow }) => guarded(bb.log, () => service.setFollow(pageId, follow)),
    unsharePage: ({ pageId }) => guarded(bb.log, async () => { await service.unsharePage(pageId); return { ok: true as const }; }),
    revealPassword: ({ pageId }) => guarded(bb.log, () => ({ password: service.revealPassword(pageId) })),
    rotatePassword: ({ pageId }) => guarded(bb.log, () => service.rotatePassword(pageId)),
  });

  /** Ask in the calling thread. True only for an explicit `{ confirmed: true }`. */
  async function confirm(threadId: string, payload: ShareConfirmPayload, signal?: AbortSignal) {
    const result = await bb.ui.requestInput({
      threadId, rendererId: CONFIRM_RENDERER_ID, title: `Share "${payload.title}"`, payload, timeoutMs: 60 * 60 * 1000,
      presentation: { label: { pending: "Waiting for share confirmation", completed: "Share confirmed" }, icon: { glyph: "Globe" } },
      describeSubmission: () => ({ title: `Shared "${payload.title}" (${describeAccess(payload)})` }),
    }, signal ? { signal } : undefined);
    const value = result.outcome === "submitted" ? result.value : null;
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.confirmed === true);
  }

  const followSchema = z.union([z.literal("latest"), z.string().uuid()]);
  bb.agents.registerTool({
    name: "page_share",
    description: "Share a page on Here.now. The user confirms in BB first. Access: restricted (allowedDomains or allowedEmails), password, or link (public to anyone with the URL). Returns { shared, url, access, follow }; never the password.",
    instructions: "page_share asks the user to confirm in BB. Use access \"link\" only when the user asked for a public link. The password is never returned; the owner copies it from the Share popover.",
    presentation: { label: { pending: "Sharing page", completed: "Shared page" }, icon: { glyph: "Globe" } },
    parameters: z.object({
      pageId: z.string().uuid(),
      access: accessSchema.describe("restricted, password, or link (public)"),
      allowedDomains: z.array(z.string()).max(20).optional().describe("For restricted: email domains allowed to sign in, e.g. example.com"),
      allowedEmails: z.array(z.string()).max(50).optional().describe("For restricted: exact emails allowed to sign in"),
      follow: followSchema.optional().describe("\"latest\" (default) follows new versions; a version id pins it"),
    }).strict(),
    async execute(raw, { threadId, signal }) {
      const input = shareInputSchema.parse(raw);
      const payload = await guarded(bb.log, () => service.confirmPayload(input));
      if (!await confirm(threadId, payload, signal)) return JSON.stringify({ shared: false, url: payload.url, access: input.access, follow: input.follow ?? "latest" });
      const share = await guarded(bb.log, () => service.sharePage(input));
      return JSON.stringify({ shared: true, url: share.url, access: share.access, follow: share.follow });
    },
  });

  const pageSelector = {
    key: { type: "string", description: "Select the page by its stable key instead of an id", placeholder: "NAME" },
    json: { type: "boolean", description: "Emit machine-readable JSON" },
  } as const;
  const selectPage = (id: string | undefined, key: string | undefined) => {
    if (Boolean(id) === Boolean(key)) throw new PluginCliError("Pass exactly one of: a page id or --key.", { code: "invalid_selector" });
    const pageId = id ?? service.pageIdByKey(key!);
    if (!pageId || !deps.getPage(pageId)) throw new PluginCliError("Page not found.", { code: "not_found" });
    return pageId;
  };
  const cli = async (run: () => Promise<PluginCliResult>): Promise<PluginCliResult> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PluginCliError) throw error;
      if (error instanceof ShareError || error instanceof HereNowError) throw new PluginCliError(error.message, { code: error.message === NOT_CONFIGURED ? "not_configured" : "share_failed" });
      if (error instanceof z.ZodError) throw new PluginCliError(error.issues.map((issue) => issue.message).join("; "), { code: "invalid_input" });
      bb.log.warn(`share command failed: ${error instanceof Error ? error.name : "unknown error"}`);
      throw new PluginCliError(safeMessage(error), { code: "share_failed" });
    }
  };
  const versionN = (share: Share) => share.follow === "latest" ? null : store.version(share.follow)?.n ?? null;

  const cliCommands: Record<string, PluginCliCommand> = {
    share: cliCommand({
      summary: "Share a page on Here.now",
      description: "Creates a Here.now site (or adopts one with --adopt) and uploads the page. Content goes up only after the access is locked and verified. In an agent thread the user confirms in BB first. The password is never printed; copy it from the Share popover.",
      positionals: [{ name: "id", description: "Page id" }],
      options: {
        ...pageSelector,
        access: { type: "enum", values: ACCESS_VALUES, required: true, description: "restricted (needs --domain or --email), password, or link (public)" },
        domain: { type: "string", repeatable: true, split: ",", description: "Allowed email domain for restricted access", placeholder: "DOMAIN" },
        email: { type: "string", repeatable: true, split: ",", description: "Allowed email for restricted access", placeholder: "EMAIL" },
        adopt: { type: "string", description: "Attach an existing Here.now site this key owns (keeps its URL)", placeholder: "SLUG" },
        pin: { type: "integer", min: 1, max: 1_000_000, description: "Share this version number and stop following new versions" },
        latest: { type: "boolean", description: "Follow the latest version (the default for a new share)" },
      },
      constraints: [{ kind: "at-most-one", options: ["pin", "latest"] }],
      run: ({ positionals, options }, ctx) => cli(async () => {
        const pageId = selectPage(positionals.id, options.key);
        let follow: ShareInput["follow"];
        if (options.pin !== undefined) {
          const versionId = service.resolveVersionN(pageId, options.pin);
          if (!versionId) throw new PluginCliError(`Version ${options.pin} not found.`, { code: "not_found" });
          follow = versionId;
        } else if (options.latest) follow = "latest";
        const input = shareInputSchema.parse({
          pageId, access: options.access, follow, adoptSlug: options.adopt,
          ...(options.domain.length ? { allowedDomains: options.domain } : {}), ...(options.email.length ? { allowedEmails: options.email } : {}),
        });
        if (ctx.threadId) {
          const payload = await service.confirmPayload(input);
          if (!await confirm(ctx.threadId, payload, ctx.signal)) return { exitCode: 1, stderr: "Cancelled. Nothing was shared." };
        }
        const share = await service.sharePage(input);
        return { exitCode: 0, stdout: options.json ? JSON.stringify(share, null, 2) : `Shared.\n${describeShare(share, versionN(share))}` };
      }),
    }),
    unshare: cliCommand({
      summary: "Stop sharing a page and delete its Here.now site",
      positionals: [{ name: "id", description: "Page id" }],
      options: pageSelector,
      run: ({ positionals, options }) => cli(async () => {
        const pageId = selectPage(positionals.id, options.key);
        await service.unsharePage(pageId);
        return { exitCode: 0, stdout: options.json ? JSON.stringify({ ok: true }) : "Unshared. The Here.now site is deleted." };
      }),
    }),
    "share-status": cliCommand({
      summary: "Show how a page is shared",
      positionals: [{ name: "id", description: "Page id" }],
      options: pageSelector,
      run: ({ positionals, options }) => cli(async () => {
        const pageId = selectPage(positionals.id, options.key);
        const { configured, share } = await service.getShare(pageId);
        const human = share ? describeShare(share, versionN(share)) : `Not shared.${configured ? "" : ` ${NOT_CONFIGURED}`}`;
        return { exitCode: 0, stdout: options.json ? JSON.stringify({ configured, share }, null, 2) : human };
      }),
    }),
  };

  return {
    onVersionCreated: (pageId, versionId) => service.onVersionCreated(pageId, versionId),
    onPageDeleted: (pageId) => service.onPageDeleted(pageId),
    cliCommands,
  };
}
