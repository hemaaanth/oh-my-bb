import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodcastProfile } from "../../shared/podcast.js";
import { makeContext, FULL_SETUP, projectRow, threadRow, DESKTOP_DEVICE, type Stubs } from "../core-test-host.js";
import { profilesFor, registerPodcast } from "./service.js";
import { registerNotices } from "../notices.js";
import { endCallsEverywhere } from "../live-session.js";
import { confirmAction, journalThread, projectTools, scopedTool } from "./tools.js";

const profile: PodcastProfile = { projectId: "proj_a", name: "Website", voice: "cedar", personality: "Calm", topics: "website", enabled: true };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); });
const stubs = (threads: Record<string, unknown> = {}, plugins: Record<string, unknown> = {}) => ({
  projects: { list: async () => [projectRow(), projectRow({ id: "proj_b", name: "Compiler" })] },
  threads: { get: async ({ threadId }: { threadId: string }) => threadRow({ id: threadId, projectId: threadId === "thr_b" ? "proj_b" : "proj_a" }), list: async () => [threadRow()], send: async () => ({}), stop: async () => ({}), output: async () => ({ output: "Tests passed. Follow-up remains." }), ...threads },
  plugins,
}) as unknown as Stubs;
async function context(overrides = stubs()) {
  const result = await makeContext(FULL_SETUP, overrides); cleanups.push(() => result.harness.lifecycle.dispose()); return result;
}
const options = () => ({ signal: new AbortController().signal, propose: vi.fn() });
const modelText = (text: string) => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
const callTool = (name: string, args: unknown) => ({ status: "completed", output: [{ type: "function_call", call_id: `fn_${name}`, name, arguments: JSON.stringify(args) }] });
const route = (projectId = "proj_a", request = "What happened?") => modelText(JSON.stringify({ routes: [{ projectId, request }], clarification: "", hold: "keep" }));
function network(responses: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/realtime/calls")) return new Response("v=0\r\n", { status: 201, headers: { "Content-Type": "application/sdp" } });
    if (url.endsWith("/audio/speech")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } });
    bodies.push(JSON.parse(String(init.body)));
    if (!responses.length) throw new Error("Unexpected model request");
    return Response.json(responses.shift());
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, bodies };
}
async function service(responses: unknown[] = [], overrides = stubs()) {
  const result = await context(overrides); const net = network(responses); registerNotices(result.ctx); registerPodcast(result.ctx);
  const session = await result.harness.behavior.callRpc("podcastOpen", { sdp: "v=0", nonce: "nonce", clientId: "browser", device: DESKTOP_DEVICE }) as { callId: string; token: string; sdp: string };
  return { ...result, ...net, session };
}
const turn = (session: { callId: string; token: string }, requestId = "one", text = "What happened?") => ({ ...session, requestId, text, projectId: "proj_a", threadId: null });

describe("project isolation", () => {
  it("rejects guessed IDs, hidden threads, and project overrides before acting", async () => {
    const { ctx, harness } = await context();
    await expect(scopedTool(ctx, profile, "send_to_thread", { thread_id: "thr_b", message: "change it" }, options())).rejects.toThrow("not available");
    await expect(scopedTool(ctx, profile, "start_thread", { project_id: "proj_b", prompt: "work" }, options())).rejects.toThrow("scope");
    harness.sdk.stub("threads.get", async () => threadRow({ visibility: "hidden" }) as never);
    await expect(scopedTool(ctx, profile, "read_thread", { thread_id: "thr_a" }, options())).rejects.toThrow("not available");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("never exposes global search, call memory, or generic plugin commands", async () => {
    const names = projectTools().map(t => t.name);
    for (const name of ["run_plugin_command", "recall_calls", "search_threads", "list_projects", "get_context"]) expect(names).not.toContain(name);
  });
  it("filters even an incorrectly broad SDK list and passes a fixed project filter", async () => {
    const { ctx, harness } = await context(stubs({ list: async () => [threadRow(), threadRow({ id: "thr_b", projectId: "proj_b", title: "Private compiler work" })] }));
    const result = await scopedTool(ctx, profile, "project_threads", { query: "", offset: 0, archived: false }, options());
    expect(JSON.stringify(result)).not.toContain("Private compiler");
    expect(harness.inspection.sdk.callsTo("threads.list")[0]).toEqual([{ projectId: "proj_a", archived: false, offset: 0, limit: 50 }]);
  });
  it("rejects mismatched Journal data and uses per-source reads rather than grouped lists", async () => {
    const rpc = vi.fn(async () => ({ thread: { threadId: "thr_a", projectId: "proj_b", summary: "private", outcome: null }, days: [], hasMore: false }));
    const { ctx } = await context(stubs({}, { callRpc: rpc }));
    await expect(journalThread(ctx, "proj_a", "thr_a")).rejects.toThrow("ownership");
    expect(rpc.mock.calls[0]).toMatchObject([{ method: "read.show", input: { threadId: "thr_a" } }]);
  });
  it("reads direct conversation rows without nested thread previews", async () => {
    const { ctx, harness } = await context(stubs({ timeline: async () => ({ rows: [{ kind: "conversation", role: "assistant", text: "Own result" }, { kind: "child_thread", children: [{ kind: "conversation", role: "assistant", text: "Private child" }] }], timelinePage: { hasOlderRows: false } }) }));
    const result = await scopedTool(ctx, profile, "thread_history", { thread_id: "thr_a", before_id: "", before_seq: "" }, options());
    expect(JSON.stringify(result)).toContain("Own result"); expect(JSON.stringify(result)).not.toContain("Private child");
    expect(harness.inspection.sdk.callsTo("threads.timeline")[0]?.[0]).toMatchObject({ includeNestedRows: "false" });
  });
  it("does not let completion updates perform mutations", async () => {
    const { ctx, harness } = await context();
    await expect(scopedTool(ctx, profile, "send_to_thread", { thread_id: "thr_a", message: "ship it" }, { ...options(), readOnly: true })).rejects.toThrow("without a user request");
    expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  });
  it("proposes stopping and rechecks project ownership when confirming", async () => {
    const { ctx, harness } = await context(); const opts = options();
    const args = { thread_id: "thr_a" };
    expect(await scopedTool(ctx, profile, "stop_thread", args, opts)).toMatchObject({ confirmationRequired: true });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
    expect(opts.propose).toHaveBeenCalledWith({ name: "stop_thread", args });
    harness.sdk.stub("threads.get", async () => threadRow({ projectId: "proj_b" }) as never);
    await expect(confirmAction(ctx, profile, { name: "stop_thread", args }, opts.signal)).rejects.toThrow("not available");
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
  });
  it("keeps an ordinary voice instruction scoped and off the user's screen", async () => {
    const { ctx, harness } = await context();
    await scopedTool(ctx, profile, "send_to_thread", { thread_id: "thr_a", message: "Please add a test." }, options());
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.open")).toHaveLength(0);
  });
  it("rejects an approval passed off as a question answer", async () => {
    const { ctx, harness } = await context(stubs({ interactions: { get: async () => ({ threadId: "thr_a", status: "pending", payload: { kind: "approval" } }) } }));
    await expect(scopedTool(ctx, profile, "answer_question", { thread_id: "thr_a", interaction_id: "approval", answers_json: "{}" }, options())).rejects.toThrow("not a pending user question");
    expect(harness.inspection.sdk.callsTo("threads.interactions.resolve")).toEqual([]);
  });
});

describe("Podcast sessions and reasoning", () => {
  it("persists voice identity when project ordering changes", async () => {
    const { ctx, harness } = await context(); const first = await profilesFor(ctx);
    harness.sdk.stub("projects.list", async () => [projectRow({ id: "proj_b" }), projectRow()] as never);
    const second = await profilesFor(ctx);
    expect(second.find(p => p.projectId === "proj_a")?.voice).toBe(first[0]?.voice);
    expect(second.find(p => p.projectId === "proj_b")?.voice).toBe(first[1]?.voice);
  });
  it("keeps the API key on the server and rejects forged or ended sessions", async () => {
    const { harness, session, ctx } = await service();
    expect(JSON.stringify(session)).not.toContain(FULL_SETUP.openaiKey);
    await expect(harness.behavior.callRpc("podcastTurn", turn({ ...session, token: "forged" }))).rejects.toThrow("ended");
    endCallsEverywhere(ctx, {});
    await expect(harness.behavior.callRpc("podcastUpdates", session)).rejects.toThrow("ended");
  });
  it("runs one action for a retried utterance and never feeds another project's answer to a speaker", async () => {
    const { harness, session, bodies } = await service([
      modelText(JSON.stringify({ routes: [{ projectId: "proj_a", request: "Add a test" }, { projectId: "proj_b", request: "Report compiler status" }], clarification: "", hold: "keep" })),
      callTool("send_to_thread", { thread_id: "thr_a", message: "Please add a test." }), modelText("I sent the website instruction."), modelText("The compiler needs a decision."),
    ]);
    const result = await harness.behavior.callRpc("podcastTurn", turn(session));
    expect(await harness.behavior.callRpc("podcastTurn", turn(session))).toEqual(result);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    const compiler = JSON.stringify(bodies.at(-1));
    expect(compiler).toContain("Report compiler status"); expect(compiler).not.toContain("website instruction");
    expect(bodies[0]?.instructions).not.toContain("Tests passed");
  });
  it("requires a separate spoken confirmation before stopping a thread", async () => {
    const { harness, session } = await service([route(), callTool("stop_thread", { thread_id: "thr_a" }), modelText("Should I stop it?"), route("proj_a", "yes")]);
    const first = await harness.behavior.callRpc("podcastTurn", turn(session)) as { speeches: Array<{ id: string }> };
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
    await harness.behavior.callRpc("podcastSpeaking", { ...session, speechId: first.speeches[0]!.id });
    await harness.behavior.callRpc("podcastTurn", turn(session, "two", "yes"));
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
  });
  it("supports holding updates without dispatching project tools", async () => {
    const { harness, session } = await service([modelText(JSON.stringify({ routes: [], clarification: "", hold: "hold" }))]);
    expect(await harness.behavior.callRpc("podcastTurn", turn(session, "hold", "hold the updates"))).toMatchObject({ hold: true });
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("rejects a hallucinated project route", async () => {
    const { harness, session } = await service([route("made-up")]);
    await expect(harness.behavior.callRpc("podcastTurn", turn(session))).rejects.toThrow("unavailable project");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
});

describe("proactive updates", () => {
  it("queues completion immediately, preserves it through speech interruption, and removes it only after playback acknowledgement", async () => {
    const { ctx, harness, session, bodies } = await service([modelText("The header tests passed. The layout follow-up is still open.")]);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_a", title: "Header", projectId: "proj_a" }), lastAssistantText: "Tests passed; follow-up remains." });
    const first = await harness.behavior.callRpc("podcastUpdates", session) as { speeches: Array<{ id: string }>; pending: number };
    expect(first.pending).toBe(1); expect(first.speeches).toHaveLength(1);
    expect(bodies[0]?.instructions).toContain("background update");
    await harness.behavior.callRpc("podcastSpeaking", { ...session, speechId: first.speeches[0]!.id });
    await harness.behavior.callRpc("podcastCancel", session);
    expect(await harness.behavior.callRpc("podcastUpdates", session)).toMatchObject({ speeches: first.speeches, pending: 1 });
    expect(ctx.db.prepare("SELECT count(*) AS n FROM podcast_updates").get()).toEqual({ n: 1 });
    await harness.behavior.callRpc("podcastHeard", { ...session, speechId: first.speeches[0]!.id });
    expect(await harness.behavior.callRpc("podcastUpdates", session)).toMatchObject({ pending: 0, speeches: [] });
  });
  it("does not expose notices for disabled, hidden, or moved threads", async () => {
    const { ctx, harness, session } = await service([]);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_a", visibility: "hidden", projectId: "proj_a" }), lastAssistantText: "Private" });
    expect(ctx.db.prepare("SELECT count(*) AS n FROM podcast_updates").get()).toEqual({ n: 0 });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_a", projectId: "proj_a" }), lastAssistantText: "Completed" });
    harness.sdk.stub("threads.get", async () => threadRow({ projectId: "proj_b" }) as never);
    expect(await harness.behavior.callRpc("podcastUpdates", session)).toMatchObject({ speeches: [], pending: 0 });
  });
  it("retains a newer result when the previous update is acknowledged", async () => {
    const { ctx, harness, session } = await service([modelText("First result")]);
    const thread = makeThreadResponse({ id: "thr_a", projectId: "proj_a" });
    await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "First result" });
    const first = await harness.behavior.callRpc("podcastUpdates", session) as { speeches: Array<{ id: string }> };
    await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Second result" });
    await harness.behavior.callRpc("podcastHeard", { ...session, speechId: first.speeches[0]!.id });
    expect(ctx.db.prepare("SELECT detail FROM podcast_updates").get()).toMatchObject({ detail: expect.stringContaining("Second result") });
  });
});


describe("voice-control regressions", () => {
  it("answers only the pending user question's allowed values", async () => {
    const interaction = { id: "q", threadId: "thr_a", status: "pending", payload: { kind: "user_question", questions: [{ id: "layout", allowFreeText: false, multiSelect: false, options: [{ value: "simple", label: "Simpler layout" }] }] } };
    const { ctx, harness } = await context(stubs({ interactions: { get: async () => interaction, resolve: async () => ({ resolved: true }) } }));
    const args = { thread_id: "thr_a", interaction_id: "q", answers_json: JSON.stringify({ layout: { selected: ["wrong"] } }) };
    await expect(scopedTool(ctx, profile, "answer_question", args, options())).rejects.toThrow("allowed choices");
    expect(harness.inspection.sdk.callsTo("threads.interactions.resolve")).toHaveLength(0);
    await scopedTool(ctx, profile, "answer_question", { ...args, answers_json: JSON.stringify({ layout: { selected: ["simple"] } }) }, options());
    expect(harness.inspection.sdk.callsTo("threads.interactions.resolve")).toEqual([[{ threadId: "thr_a", interactionId: "q", resolution: { kind: "user_answer", answers: { layout: { selected: ["simple"] } } } }]]);
  });
  it("does not mistake a later unrelated spoken answer for consent to an old action", async () => {
    const { harness, session } = await service([route(), callTool("stop_thread", { thread_id: "thr_a" }), modelText("Should I stop it?"), route("proj_a", "yes")]);
    await harness.behavior.callRpc("podcastTurn", turn(session));
    // The proposal never reached playback. A generic yes cannot execute it.
    const result = await harness.behavior.callRpc("podcastTurn", turn(session, "two", "yes"));
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    expect(JSON.stringify(result)).toContain("propose that action again");
  });
  it("caches speech bytes and makes playback acknowledgements idempotent", async () => {
    const { ctx, harness, session, fetcher } = await service([route(), modelText("The test is ready.")]);
    const result = await harness.behavior.callRpc("podcastTurn", turn(session)) as { speeches: Array<{ id: string }> };
    const input = { ...session, speechId: result.speeches[0]!.id };
    expect(await harness.behavior.callRpc("podcastAudio", input)).toEqual(await harness.behavior.callRpc("podcastAudio", input));
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("audio/speech"))).toHaveLength(1);
    await harness.behavior.callRpc("podcastHeard", input); await harness.behavior.callRpc("podcastHeard", input);
    expect(ctx.db.prepare("SELECT count(*) AS n FROM call_trace WHERE kind='speech.agent'").get()).toEqual({ n: 1 });
  });
  it("rotates equal-priority updates to another project", async () => {
    const { ctx, harness, session } = await service([modelText("Website update"), modelText("Compiler update")]);
    const add = ctx.db.prepare("INSERT INTO podcast_updates (id,project_id,thread_id,detail,created_at,priority) VALUES (?,?,?,?,?,0)");
    add.run("a1", "proj_a", "thr_a", "First Website update", Date.now());
    add.run("a2", "proj_a", "thr_a2", "Second Website update", Date.now() + 1);
    add.run("b1", "proj_b", "thr_b", "Compiler update", Date.now() + 2);
    const first = await harness.behavior.callRpc("podcastUpdates", session) as { speeches: Array<{ id: string; projectId: string }> };
    expect(first.speeches[0]?.projectId).toBe("proj_a");
    await harness.behavior.callRpc("podcastHeard", { ...session, speechId: first.speeches[0]!.id });
    const second = await harness.behavior.callRpc("podcastUpdates", session) as { speeches: Array<{ projectId: string }> };
    expect(second.speeches[0]?.projectId).toBe("proj_b");
  });
  it("closing a stale session cannot close a newer call", async () => {
    const { ctx, harness, session } = await service();
    const newer = await harness.behavior.callRpc("podcastOpen", { sdp: "v=0", nonce: "newer", clientId: "browser", device: DESKTOP_DEVICE }) as { callId: string; token: string };
    await harness.behavior.callRpc("podcastClose", session);
    expect(await harness.behavior.callRpc("podcastUpdates", newer)).toMatchObject({ speeches: [] });
    expect(ctx.db.prepare("SELECT ended_at FROM calls WHERE id=?").get(newer.callId)).toEqual({ ended_at: null });
  });
});


it("expires abandoned calls but keeps a browser with heartbeats alive", async () => {
  vi.useFakeTimers();
  try {
    const { harness, session } = await service();
    await vi.advanceTimersByTimeAsync(60000);
    await harness.behavior.callRpc("podcastHeartbeat", session);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await harness.behavior.callRpc("podcastUpdates", session)).toMatchObject({ speeches: [] });
    await vi.advanceTimersByTimeAsync(120000);
    await expect(harness.behavior.callRpc("podcastUpdates", session)).rejects.toThrow("ended");
  } finally { vi.useRealTimers(); }
});


it("opens a call with more than thirty participating projects", async () => {
  const overrides = stubs();
  overrides.projects = { list: async () => Array.from({ length: 42 }, (_, index) => projectRow({ id: `proj_${index}`, name: `Project ${index}` })) } as unknown as Stubs["projects"];
  const { session } = await service([], overrides);
  expect(session.callId).toBeTruthy();
});
