import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { rpcContract } from "./server";
import { GuestScreenshotGrants } from "./lib/guest-screenshots";
import { SCREENSHOT_UPLOAD_WINDOW_MS } from "./lib/store";
import type { GuestFeedback } from "./lib/guest-review";

const scope = { isolationVersion: 1, threadId: "thread-test", url: "https://preview.example.test/pricing", reviewRef: "synthetic-review", participantRef: "synthetic-participant" } as const;
const capture = { ...scope, comment: "Synthetic guest-only feedback", clientId: "pp_guestcapture" };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
async function host(get = async () => ({ projectId: "project-test", environmentId: null })) {
  const send = vi.fn(async () => ({}));
  const integration = vi.fn(async () => { throw new Error("No optional integration is installed in this fixture"); });
  const { bb, harness } = createFakePluginHost({
    pluginId: "pinpoint", settings: { autoDispatch: true, relayMode: "thread" },
    sdk: { threads: { get, send }, plugins: { callRpc: integration } },
  });
  await plugin(bb);
  disposals.push(() => harness.lifecycle.dispose());
  const rows = async () => rpcContract.list.output.parse(await harness.behavior.callRpc("list", { threadId: scope.threadId })).rows;
  const guestRows = async (extra = {}) => rpcContract.listGuest.output.parse(await harness.behavior.callRpc("listGuest", { ...scope, ...extra })).rows;
  const approve = async (id: string, changes: Partial<GuestFeedback> = {}) => {
    const pending = (await rows()).find((row) => row.annotation.id === id)?.guestFeedback;
    if (!pending) throw new Error("Fixture has no pending guest feedback.");
    return harness.behavior.callRpc("approveGuestFeedback", { id, ...pending, ...changes });
  };
  return { ...harness, send, integration, rows, guestRows, approve };
}

describe("guest feedback execution boundary", () => {
  it("holds captures outside agent tools and CLI until the owner's exact approval, regardless of global auto-dispatch", async () => {
    const h = await host();
    for (const integration of ["agents", "providerUsage", "clasi"]) await h.behavior.callRpc("setIntegration", { integration, enabled: true });
    const receipt = rpcContract.captureGuest.output.parse(await h.behavior.callRpc("captureGuest", capture));
    expect((await h.rows())[0]).toMatchObject({ guestPending: true, workflowState: "open" });
    expect(await h.behavior.callAgentTool("pinpoint_list", {})).not.toContain(capture.comment);
    expect(JSON.stringify(await h.behavior.callAgentTool("pinpoint_show", { id: receipt.captureId }))).not.toContain(capture.comment);
    expect((await h.behavior.runCli(["show", receipt.captureId], { threadId: scope.threadId })).exitCode).toBe(1);
    await h.behavior.callAgentTool("pinpoint_resolve", { id: receipt.captureId, outcome: "ready", summary: "not authorized" });
    expect((await h.rows())[0]!.workflowState).toBe("open");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.integration).not.toHaveBeenCalled();
    expect(h.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    await expect(h.behavior.callRpc("update", { id: receipt.captureId, action: "redispatch" })).rejects.toThrow();
    await h.approve(receipt.captureId);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.send.mock.calls)).toContain(capture.comment);
    expect((await h.rows())[0]!.guestPending).toBe(false);
    expect((await h.guestRows())[0]!.guestCanDelete).toBe(false);
    expect(h.integration).not.toHaveBeenCalled();
  });

  it("withholds guest replies, including one arriving during owner routing, without reopening or sending", async () => {
    let block = false;
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const h = await host(async () => {
      if (block) { entered.resolve(); await gate.promise; }
      return { projectId: "project-test", environmentId: null };
    });
    const own = rpcContract.capture.output.parse(await h.behavior.callRpc("capture", { threadId: scope.threadId, url: scope.url, comment: "Owner feedback" }));
    const id = own.captureId;
    await h.behavior.callRpc("replyGuest", { ...scope, id, text: "Guest reply awaiting approval" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect((await h.rows())[0]).toMatchObject({ workflowState: "dispatched", guestPending: true });
    const show = () => h.behavior.callAgentTool("pinpoint_show", { id });
    expect(JSON.stringify(await show())).not.toContain("Guest reply awaiting approval");
    block = true;
    const dispatch = h.approve(id);
    await entered.promise;
    await h.behavior.callRpc("replyGuest", { ...scope, id, text: "Racing guest reply stays private" });
    gate.resolve();
    await dispatch;
    expect(h.send).toHaveBeenCalledTimes(2);
    const delivered = JSON.stringify(h.send.mock.calls[1]);
    expect(delivered).toContain("Guest reply awaiting approval");
    expect(delivered).not.toContain("Racing guest reply stays private");
    expect(JSON.stringify(await show())).not.toContain("Racing guest reply stays private");
    expect((await h.rows())[0]!.guestPending).toBe(true);
    expect((await h.guestRows())[0]!.guestCanDelete).toBe(false);
    block = false;
    await h.approve(id);
    expect(JSON.stringify(h.send.mock.calls[2])).toContain("Racing guest reply stays private");
    expect((await h.rows())[0]!.guestPending).toBe(false);
  });

  it("limits deletion to the originating participant's held capture and revokes its screenshot receipt", async () => {
    const h = await host();
    const receipt = rpcContract.captureGuest.output.parse(await h.behavior.callRpc("captureGuest", capture));
    const id = receipt.captureId;
    for (const extra of [{ participantRef: "someone-else" }, { reviewRef: "another-review" }, { threadId: "another-thread" }, { url: "https://preview.example.test/another-page" }]) {
      await expect(h.behavior.callRpc("deleteGuest", { ...scope, ...extra, id })).rejects.toThrow();
    }
    expect((await h.guestRows())[0]!.guestCanDelete).toBe(true);
    expect((await h.guestRows({ participantRef: "someone-else" }))[0]!.guestCanDelete).toBe(false);
    await h.behavior.callRpc("deleteGuest", { ...scope, id });
    expect(await h.rows()).toEqual([]);
    await expect(h.behavior.callRpc("uploadGuestScreenshot", { isolationVersion: 1, token: receipt.screenshotUpload!.token, kind: "element", mime: "image/png", screenshot: "dGVzdA==" })).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("binds uploads to canonical collision-safe captures and prevents overwrite, expiry and scope confusion", async () => {
    const h = await host();
    await h.behavior.callRpc("captureGuest", capture);
    const next = rpcContract.captureGuest.output.parse(await h.behavior.callRpc("captureGuest", capture));
    expect(next.captureId).not.toBe(capture.clientId);
    const upload = { isolationVersion: 1, token: next.screenshotUpload!.token, kind: "element", mime: "image/png", screenshot: "dGVzdA==" };
    await expect(h.behavior.callRpc("uploadGuestScreenshot", { ...upload, token: "unknown" })).rejects.toThrow();
    await expect(h.behavior.callRpc("uploadGuestScreenshot", { ...upload, id: capture.clientId })).rejects.toThrow();
    await h.behavior.callRpc("uploadGuestScreenshot", upload);
    await expect(h.behavior.callRpc("uploadGuestScreenshot", { ...upload, screenshot: "b3ZlcndyaXRl" })).rejects.toThrow();
    const read = (id: string, extra = {}) => h.behavior.callRpc("screenshotGuest", { ...scope, ...extra, id, kind: "element" });
    expect(await read(next.captureId)).toEqual({ shot: { mime: "image/png", data: "dGVzdA==" } });
    expect(await read(capture.clientId)).toEqual({ shot: null });
    await expect(read(next.captureId, { threadId: "another-thread" })).rejects.toThrow();
    await expect(read(next.captureId, { url: "https://preview.example.test/another-page" })).rejects.toThrow();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + SCREENSHOT_UPLOAD_WINDOW_MS + 1);
    await expect(h.behavior.callRpc("uploadGuestScreenshot", { ...upload, kind: "viewport" })).rejects.toThrow("expired");
  });

  it("projects only public page fields, without nested owner provenance, learning, receipt or routing data", async () => {
    const h = await host();
    const owner = rpcContract.capture.output.parse(await h.behavior.callRpc("capture", { threadId: scope.threadId, url: scope.url, comment: "Owner comment", nearbyText: "Private surrounding context", sourceFile: "private-component.tsx" }));
    await h.behavior.callAgentTool("pinpoint_resolve", {
      id: owner.captureId, outcome: "ready", summary: "Aligned", receipt: "Private implementation receipt",
      proposedLearning: { topic: "design", logicalKey: "quiet-buttons", text: "Prefer quiet secondary buttons." },
    });
    await h.behavior.callRpc("captureGuest", capture);
    await h.behavior.callRpc("captureGuest", { ...capture, url: "https://preview.example.test/another-page", clientId: "pp_anotherpage", comment: "Other page secret" });
    const rows = await h.guestRows();
    expect(rows.map((row) => row.annotation.comment).sort()).toEqual([capture.comment, "Owner comment"].sort());
    const publicText = JSON.stringify(rows);
    for (const value of ["Private surrounding context", "private-component.tsx", "Private implementation receipt", "Prefer quiet secondary buttons.", scope.reviewRef, scope.participantRef, "assignedThreadId", "projectId"]) expect(publicText).not.toContain(value);
    expect(rows.find((row) => row.annotation.id === owner.captureId)).toMatchObject({ guestCanDelete: false, authoredByGuest: false });
  });

  it("approves edited guest text atomically, rejects stale batches, and keeps originals out of agent and guest projections", async () => {
    const h = await host();
    const receipt = rpcContract.captureGuest.output.parse(await h.behavior.callRpc("captureGuest", { ...capture, comment: "Raw opening suggestion" }));
    const id = receipt.captureId;
    const stale = (await h.rows())[0]!.guestFeedback!;
    await h.behavior.callRpc("replyGuest", { ...scope, id, text: "Raw guest follow-up" });
    await expect(h.behavior.callRpc("approveGuestFeedback", { id, ...stale })).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    const pending = (await h.rows())[0]!.guestFeedback!;
    await expect(h.approve(id, { messages: [] })).rejects.toThrow();
    expect((await h.rows())[0]!.annotation.comment).toBe("Raw opening suggestion");
    await h.approve(id, {
      capture: { comment: "Owner-approved opening", textNew: null },
      messages: pending.messages.map((message) => ({ ...message, content: "Owner-approved follow-up" })),
    });
    const stored = (await h.rows())[0]!;
    expect(stored.annotation.comment).toBe("Owner-approved opening");
    expect(stored.annotation.pinpoint.guestOriginal?.comment).toBe("Raw opening suggestion");
    expect(stored.annotation.thread[0]).toMatchObject({ content: "Owner-approved follow-up", guestOriginalContent: "Raw guest follow-up", pendingOwnerDispatch: false });
    const sent = JSON.stringify(h.send.mock.calls);
    const agent = JSON.stringify(await h.behavior.callAgentTool("pinpoint_show", { id }));
    for (const output of [sent, agent, JSON.stringify(await h.guestRows())]) {
      expect(output).not.toContain("Raw opening suggestion");
      expect(output).not.toContain("Raw guest follow-up");
    }
    expect(sent).toContain("Owner-approved opening");
    expect(sent).toContain("Owner-approved follow-up");
    expect((await h.guestRows())[0]!.annotation.pinpoint.ownerEdited).toBe(true);
    expect((await h.guestRows())[0]!.annotation.thread[0]!.ownerEdited).toBe(true);
  });

  it("requires a fresh guest approval after comments on ready and completed work, without granting completion or learning", async () => {
    const h = await host();
    await h.behavior.callRpc("setIntegration", { integration: "clasi", enabled: true });
    const owner = rpcContract.capture.output.parse(await h.behavior.callRpc("capture", { threadId: scope.threadId, url: scope.url, comment: "Owner request" }));
    const id = owner.captureId;
    await h.behavior.callAgentTool("pinpoint_resolve", { id, outcome: "ready", summary: "Ready for the owner" });
    await h.behavior.callRpc("replyGuest", { ...scope, id, text: "A guest requests another change" });
    expect((await h.rows())[0]).toMatchObject({ workflowState: "ready", guestPending: true });
    for (const action of ["approve", "feedback", "redispatch"]) {
      await expect(h.behavior.callRpc("update", { id, action })).rejects.toThrow();
    }
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.integration).not.toHaveBeenCalled();
    await h.approve(id);
    expect((await h.rows())[0]).toMatchObject({ workflowState: "dispatched", guestPending: false });
    await h.behavior.callAgentTool("pinpoint_resolve", { id, outcome: "ready", summary: "Revised" });
    await h.behavior.callRpc("update", { id, action: "approve" });
    expect((await h.rows())[0]!.workflowState).toBe("approved");
    await h.behavior.callRpc("replyGuest", { ...scope, id, text: "One more guest comment" });
    expect((await h.rows())[0]).toMatchObject({ workflowState: "approved", guestPending: true });
    expect(h.send).toHaveBeenCalledTimes(2);
    await h.approve(id);
    expect((await h.rows())[0]).toMatchObject({ workflowState: "dispatched", guestPending: false });
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.integration).not.toHaveBeenCalled();
  });

  it("lets the owner revise proposed guest copy without losing the captured old text", async () => {
    const h = await host();
    const receipt = rpcContract.captureGuest.output.parse(await h.behavior.callRpc("captureGuest", {
      ...capture, kind: "text-edit", comment: "", textOld: "Original page copy", textNew: "Raw guest replacement",
    }));
    expect(receipt.screenshotUpload).toBeNull();
    await h.approve(receipt.captureId, { capture: { comment: "", textNew: "Owner-approved replacement" } });
    const row = (await h.rows())[0]!;
    expect(row.annotation).toMatchObject({ textOld: "Original page copy", textNew: "Owner-approved replacement" });
    expect(row.annotation.pinpoint.guestOriginal?.textNew).toBe("Raw guest replacement");
    expect(JSON.stringify(h.send.mock.calls)).not.toContain("Raw guest replacement");
    expect(JSON.stringify(h.send.mock.calls)).toContain("Owner-approved replacement");
  });

  it("includes an unprocessed original capture when a guest comments again after dismissal", async () => {
    const h = await host();
    const receipt = rpcContract.captureGuest.output.parse(await h.behavior.callRpc("captureGuest", capture));
    const id = receipt.captureId;
    await h.behavior.callRpc("update", { id, action: "dismiss" });
    await h.behavior.callRpc("replyGuest", { ...scope, id, text: "Please reconsider this request" });
    expect((await h.rows())[0]!.guestFeedback?.capture?.comment).toBe(capture.comment);
    await h.approve(id);
    expect((await h.rows())[0]).toMatchObject({ guestPending: false, workflowState: "dispatched" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the owning thread cannot be resolved", async () => {
    const h = await host(async () => { throw new Error("Synthetic unavailable thread"); });
    await expect(h.behavior.callRpc("captureGuest", capture)).rejects.toThrow("unavailable");
    expect(await h.rows()).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  });
});

it("never revives expired guest screenshot capabilities", () => {
  const grants = new GuestScreenshotGrants();
  const grant = grants.create({ annotationId: "pp_synthetic", threadId: scope.threadId, url: scope.url, reviewRef: scope.reviewRef, participantRef: scope.participantRef }, 0);
  expect(grants.get(grant.token, SCREENSHOT_UPLOAD_WINDOW_MS)).toBeNull();
  expect(grants.get(grant.token, 1)).toBeNull();
});
