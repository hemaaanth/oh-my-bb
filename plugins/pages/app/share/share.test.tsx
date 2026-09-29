// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../../app.js"));
// These import the SDK app runtime, which loadPluginApp installs.
const { ShareButton, SharePopover, ShareConfirm, CONFIRM_RENDERER_ID } = await import("./SharePopover.js");
const { resetPagesCache } = await import("../data.js");

const pageId = "123e4567-e89b-42d3-a456-426614174000";
const v1 = "123e4567-e89b-42d3-a456-426614174001";
const v2 = "123e4567-e89b-42d3-a456-426614174002";
const detail = {
  page: { id: pageId, title: "T1 hello", kind: "file", projectId: null, sourceKey: null, producer: null, producerKey: null, currentVersionId: v2, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" },
  version: { id: v2, n: 2, label: null, createdAt: "2026-09-24T00:00:00.000Z", pageId, sourcePath: null, sha256: "x", threadId: null, provenance: null, document: null, hasCharts: false },
  versions: [{ id: v1, n: 1, label: "draft", createdAt: "2026-09-23T00:00:00.000Z" }, { id: v2, n: 2, label: null, createdAt: "2026-09-24T00:00:00.000Z" }],
  share: null, previewUrl: `/api/v1/plugins/pages/http/v?id=${v2}`,
} as const;
const shareOf = (overrides: Record<string, unknown> = {}) => ({
  pageId, provider: "here-now", slug: "quiet-otter", url: "https://quiet-otter.here.now/", access: "password", allowedDomains: [], allowedEmails: [],
  hasPassword: true, follow: "latest", liveVersionId: v2, status: "ready", lastError: null, updatedAt: "2026-09-24T00:00:00.000Z", ...overrides,
});
const status = (share: unknown, configured = true, defaults = { access: "password", allowedDomains: ["example.com"] }) => ({ configured, share, defaults });
const SECRET = "s3cret-Pa55word";

const writeText = vi.fn(async (_text: string) => undefined);
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
afterEach(() => { cleanup(); writeText.mockClear(); resetPagesCache(); });

function popover(rpc: Record<string, (input: never) => unknown>) {
  return renderSlot({ component: () => <SharePopover detail={detail as never} /> }, {} as never, { rpc: rpc as never });
}
const openMenu = async (slot: ReturnType<typeof popover>, name: RegExp) => fireEvent.keyDown(await slot.findByRole("button", { name }), { key: "Enter" });

describe("Share popover", () => {
  it("shares a new page with the defaults after a one-line confirm", async () => {
    const sharePage = vi.fn(() => shareOf());
    const slot = popover({ getShare: () => status(null), sharePage });
    expect(await slot.findByText("No link yet")).toBeTruthy();
    expect(slot.getByText("Share uses password by default.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Share" }));
    expect(slot.getByRole("alert").textContent).toContain("Share with a password?");
    expect(sharePage).not.toHaveBeenCalled();
    fireEvent.click(slot.getAllByRole("button", { name: "Share" }).at(-1)!);
    await waitFor(() => expect(sharePage).toHaveBeenCalledWith({ pageId, access: "password", follow: "latest" }));
  });

  it("points to settings and disables Share when the key is not set", async () => {
    const slot = popover({ getShare: () => status(null, false) });
    expect(await slot.findByText(/^Here.now key not set/u)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Share" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows the link and a masked password; Copy reads it through revealPassword", async () => {
    const revealPassword = vi.fn(() => ({ password: SECRET }));
    const slot = popover({ getShare: () => status(shareOf()), revealPassword });
    expect((await slot.findByLabelText("Share link")).textContent).toBe("https://quiet-otter.here.now/");
    expect(slot.getByLabelText("Password").textContent).toBe("••••••••••••");
    expect(slot.getByRole("status").textContent).toBe("Live · v2 · follows new versions");
    fireEvent.click(slot.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    expect(revealPassword).toHaveBeenCalledWith({ pageId });
    expect(await slot.findByText("Password copied.")).toBeTruthy();
    expect(slot.container.ownerDocument.body.textContent).not.toContain(SECRET);
  });

  it("asks before making a private page public", async () => {
    const sharePage = vi.fn(() => shareOf({ access: "link", hasPassword: false }));
    const slot = popover({ getShare: () => status(shareOf()), sharePage });
    await openMenu(slot, /^Access:/u);
    fireEvent.click(slot.getByRole("menuitemradio", { name: /Anyone with the link/u }));
    expect(slot.getByRole("alert").textContent).toContain("Anyone with the link can view this page.");
    expect(sharePage).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Make public" }));
    await waitFor(() => expect(sharePage).toHaveBeenCalledWith({ pageId, access: "link" }));
  });

  it("edits restricted chips and applies them", async () => {
    const sharePage = vi.fn(() => shareOf({ access: "restricted", allowedDomains: ["example.com"], allowedEmails: ["ana@example.com"] }));
    const slot = popover({ getShare: () => status(shareOf({ access: "restricted", allowedDomains: ["example.com"], hasPassword: false })), sharePage });
    expect(await slot.findByText("example.com")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Apply" })).toBeNull();
    const input = slot.getByLabelText("Add a domain or email");
    fireEvent.change(input, { target: { value: "not valid" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "Ana@Example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(slot.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(sharePage).toHaveBeenCalledWith({ pageId, access: "restricted", allowedDomains: ["example.com"], allowedEmails: ["ana@example.com"] }));
  });

  it("pins a version, and retries after an error", async () => {
    const setFollow = vi.fn(() => shareOf());
    const slot = popover({ getShare: () => status(shareOf({ status: "error", lastError: "Upload refused: Here.now reports anyone with the link, but this share is password." })), setFollow });
    expect((await slot.findByRole("alert")).textContent).toContain("Upload refused");
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(setFollow).toHaveBeenCalledWith({ pageId, follow: "latest" }));
    await openMenu(slot, /^Shared version:/u);
    fireEvent.click(slot.getByRole("menuitemradio", { name: /Pin v1/u }));
    await waitFor(() => expect(setFollow).toHaveBeenLastCalledWith({ pageId, follow: v1 }));
  });

  it("asks before deleting the site", async () => {
    const unsharePage = vi.fn(() => ({ ok: true }));
    const slot = popover({ getShare: () => status(shareOf()), unsharePage });
    await openMenu(slot, /^Access:/u);
    fireEvent.click(slot.getByRole("menuitemradio", { name: "Not shared" }));
    expect(unsharePage).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(unsharePage).toHaveBeenCalledWith({ pageId }));
  });
});

describe("Share button", () => {
  it("shows a globe for public links and a label for errors, from the share it is given", async () => {
    const link = renderSlot({ component: () => <ShareButton compact pageId={pageId} share={shareOf({ access: "link" }) as never} /> }, {} as never, { rpc: {} as never });
    expect(await link.findByRole("button", { name: "Shared: Anyone with the link" })).toBeTruthy();
    // The button itself costs no request; the popover loads the share status when it opens.
    expect(link.inspection.rpcCalls).toHaveLength(0);
    cleanup();
    const failed = renderSlot({ component: () => <ShareButton pageId={pageId} share={shareOf({ status: "error" }) as never} /> }, {} as never, { rpc: {} as never });
    expect(await failed.findByRole("button", { name: "Share: needs attention" })).toBeTruthy();
  });

  it("takes a snapshot first for a live file", async () => {
    const onNeedsPage = vi.fn(async () => pageId);
    const slot = renderSlot({ component: () => <ShareButton compact pageId={null} onNeedsPage={onNeedsPage} /> }, {} as never, {
      rpc: { getShare: () => status(null), getPage: () => detail } as never,
    });
    fireEvent.click(slot.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(onNeedsPage).toHaveBeenCalledTimes(1));
    expect(await slot.findByText("No link yet")).toBeTruthy();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "getShare" && JSON.stringify(call.input) === JSON.stringify({ pageId }))).toBe(true);
  });
});

describe("page_share confirmation", () => {
  it("is registered, shows the share, and submits { confirmed: true }", async () => {
    expect(app.pendingInteractions.map(({ id }) => id)).toContain(CONFIRM_RENDERER_ID);
    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const payload = { pageId, title: "T1 hello", versionN: 2, access: "restricted", allowedDomains: ["example.com"], allowedEmails: ["ana@example.com"], follow: "latest", url: null, adoptSlug: null, firstShare: true, goesPublic: false, replaces: null };
    const slot = renderSlot({ component: ShareConfirm }, { interaction: { id: "i1", threadId: "thr_a", title: "Share", payload, createdAt: 0, expiresAt: null }, submit, cancel } as never);
    expect(slot.getByText("Share “T1 hello”")).toBeTruthy();
    expect(slot.getByText("v2")).toBeTruthy();
    expect(slot.getByText("ana@example.com")).toBeTruthy();
    expect(slot.getByText("Latest. The link follows new versions of this page.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ confirmed: true }));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("says when the link becomes public", () => {
    const payload = { pageId, title: "T1 hello", versionN: 1, access: "link", allowedDomains: [], allowedEmails: [], follow: 1, url: "https://quiet-otter.here.now/", adoptSlug: null, firstShare: false, goesPublic: true, replaces: "password" };
    const slot = renderSlot({ component: ShareConfirm }, { interaction: { id: "i2", threadId: "thr_a", title: "Share", payload, createdAt: 0, expiresAt: null }, submit: vi.fn(), cancel: vi.fn() } as never);
    expect(slot.getByText("Anyone with the link can view this page.")).toBeTruthy();
    expect(slot.getByText("Now: password")).toBeTruthy();
    expect(slot.getByText("Pinned to v1. New versions stay private.")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Make public" })).toBeTruthy();
  });
});
