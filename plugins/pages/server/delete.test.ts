import { describe, expect, it, vi } from "vitest";
import { WORKSPACE, pagesHost } from "./test-fakes.js";

const onPageDeleted = vi.fn(async (_pageId: string) => {});
vi.mock("./share/index.js", () => ({
  registerShare: () => ({ onVersionCreated: async () => {}, onPageDeleted, cliCommands: {} }),
}));

describe("deletePage", () => {
  it("tells the share hook after the page is gone, and not for an unknown page", async () => {
    const { harness, files } = pagesHost();
    files.set(`${WORKSPACE}/d.html`, "<h1>D</h1>");
    const published = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "d.html" }) as { page: { id: string } };
    onPageDeleted.mockImplementationOnce(async (pageId) => {
      // The page is already soft-deleted when Sharing runs.
      expect(await harness.behavior.callRpc("getPage", { pageId })).toBeNull();
    });
    await expect(harness.behavior.callRpc("deletePage", { pageId: published.page.id })).resolves.toEqual({ ok: true });
    expect(onPageDeleted).toHaveBeenCalledExactlyOnceWith(published.page.id);

    await expect(harness.behavior.callRpc("deletePage", { pageId: published.page.id })).rejects.toThrow(/not found/i);
    expect(onPageDeleted).toHaveBeenCalledTimes(1);
    await harness.lifecycle.dispose();
  });
});
