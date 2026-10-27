import { createFakePluginHost, makeThreadResponse, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { registerBrowserHandoff } from "../src/browser-handoff.js";

const dispose: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of dispose.splice(0)) await fn(); });
function setup(desktop?:{openDesktop:(hostId:string,threadId:string,viewOnly?:boolean)=>Promise<string|null>;closeDesktop:(threadId:string)=>Promise<void>},sandbox=false) {
  const thread = makeThreadResponse({ id: "thr_browser", environmentId: "env_browser" });
  const host = makeHostResponse({ id: "host_browser", name: "My desktop",machineProviderId:sandbox?"sandbox-daytona":null, status: "connected", lifecycle: { phase: "active", suspendedAt: null, message: null, pendingLog: "", teardown: null } });
  let ok = true;
  const fake = createFakePluginHost({ pluginId: "sandboxes", experimental_hostEntry: true, sdk: {
    threads: { get: async () => thread }, environments: { get: async () => ({ hostId: host.id }) }, hosts: { get: async () => host },
  }, experimental_callHostRpc: async () => ({ok}) });
  dispose.push(() => fake.harness.lifecycle.dispose());
  const idle = {hold:vi.fn(), release:vi.fn(),...desktop};
  registerBrowserHandoff(fake.bb, idle);
  const actions = () => fake.harness.experimental_hostRpcCalls.map(call => (call.input as { action:string }).action);
  const start = () => fake.harness.behavior.callAgentTool("browser_handoff", {reason:"login", instructions:"Sign in on the browser, then select Done."}, {threadId:thread.id});
  return {...fake, thread, host, actions, start, idle, setOk:(value:boolean) => {ok=value;}};
}
it("shows native attention card, preserves window while idle, and resumes only after Done", async () => {
  const {harness, thread, actions, start, idle} = setup();
  const result = start();
  await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
  expect(actions()).toEqual(["pause"]);
  expect(idle.hold).toHaveBeenCalledWith("host_browser", "thr_browser");
  expect(idle.release).not.toHaveBeenCalled();
  expect(harness.pendingInteractions[0]).toMatchObject({threadId:thread.id, rendererId:"browser-handoff", payload:{host:"My desktop", reason:"login"}});
  await harness.behavior.emitThreadEvent("thread.idle", {thread, lastAssistantText:"Waiting"});
  expect(actions()).toEqual(["pause"]);
  expect(await harness.behavior.callRpc("showBrowserHandoff", {threadId:thread.id})).toEqual({ok:true});
  harness.behavior.submitInteraction(harness.pendingInteractions[0].id, {done:true});
  expect(await result).toContain("fresh bb-browser snapshot");
  expect(actions()).toEqual(["pause", "show", "resume"]);
  expect(idle.release).toHaveBeenCalledWith("host_browser", "thr_browser");
  await harness.behavior.emitThreadEvent("thread.idle", {thread, lastAssistantText:"Done"});
  expect(actions()).toEqual(["pause", "show", "resume", "close"]);
});
it("cancel closes only the waiting thread's window and returns an error result", async () => {
  const {harness, actions, start} = setup(); const result = start();
  await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
  harness.behavior.submitInteraction(harness.pendingInteractions[0].id, {done:false});
  expect(await result).toMatchObject({isError:true}); expect(actions()).toEqual(["pause", "discard"]);
  expect(harness.experimental_hostRpcCalls.every(call => (call.input as {threadId:string}).threadId === "thr_browser")).toBe(true);
});
it("rejects duplicate handoffs and opening a different thread's window", async () => {
  const {harness, start} = setup(); const result = start();
  await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
  await expect(start()).rejects.toThrow("already has");
  await expect(harness.behavior.callRpc("showBrowserHandoff", {threadId:"thr_other"})).rejects.toThrow("not waiting");
  harness.behavior.cancelInteraction(harness.pendingInteractions[0].id); await result;
});
it("does not ask for input when pausing fails; cleans up on stopped tools", async () => {
  const {harness, setOk, start} = setup(); setOk(false);
  await expect(start()).rejects.toThrow("Could not pause"); expect(harness.pendingInteractions).toHaveLength(0);
});
it("never wakes a disconnected or sleeping host for cleanup", async () => {
  const {harness, thread, host, actions} = setup(); host.status="disconnected";
  await harness.behavior.emitThreadEvent("thread.archived", {thread}); expect(actions()).toEqual([]);
});

it("uses the Sandboxes desktop and revokes it before resuming automation",async()=>{
 const openDesktop=vi.fn(async()=>"https://sandbox--1234.getbb.app/#grant"),closeDesktop=vi.fn(async()=>{});
 const {harness,start,actions}=setup({openDesktop,closeDesktop});
 closeDesktop.mockImplementation(async()=>{expect(actions()).toEqual(["pause"]);});
 const result=start();await vi.waitFor(()=>expect(harness.pendingInteractions).toHaveLength(1));
 expect(harness.pendingInteractions[0]).toMatchObject({payload:{viewerUrl:"https://sandbox--1234.getbb.app/#grant"}});
 expect(openDesktop).toHaveBeenCalledWith("host_browser","thr_browser");
 harness.behavior.submitInteraction(harness.pendingInteractions[0].id,{done:true});await result;
 expect(closeDesktop).toHaveBeenCalledWith("thr_browser");expect(actions()).toEqual(["pause","resume"]);
});
it("does not fall back to screenshot polling when the desktop service fails",async()=>{
 const {harness,start}=setup({openDesktop:async()=>{throw Error("Desktop unavailable");},closeDesktop:async()=>{}});
 await expect(start()).rejects.toThrow("Desktop unavailable");expect(harness.pendingInteractions).toHaveLength(0);
});

it("discards instead of resuming when VNC revocation cannot be confirmed",async()=>{
 const {harness,start,actions}=setup({openDesktop:async()=>"https://sandbox.example/#grant",closeDesktop:async()=>{throw Error("offline");}});
 const result=start();await vi.waitFor(()=>expect(harness.pendingInteractions).toHaveLength(1));harness.behavior.submitInteraction(harness.pendingInteractions[0].id,{done:true});
 expect(await result).toMatchObject({isError:true});expect(actions()).toEqual(["pause","discard"]);
});

it('opens live sandbox viewing without pausing and keeps idle sessions until the view closes',async()=>{
 const openDesktop=vi.fn(async()=> 'https://sandbox--1234.getbb.app/#grant'),closeDesktop=vi.fn(async()=>{});
 const {harness,thread,actions}=setup({openDesktop,closeDesktop},true);
 const result=await harness.behavior.callAgentTool('browser_live',{action:'open'},{threadId:thread.id});expect(result).toContain('::browser-live{}');
 expect(openDesktop).toHaveBeenCalledWith('host_browser',thread.id,true);expect(actions()).toEqual([]);expect(harness.pendingInteractions).toHaveLength(0);
 await harness.behavior.callRpc('openBrowserView',{threadId:thread.id});expect(openDesktop).toHaveBeenCalledOnce();
 await harness.behavior.emitThreadEvent('thread.idle',{thread,lastAssistantText:'Watching'});expect(actions()).toEqual([]);
 await harness.behavior.callRpc('closeBrowserView',{threadId:thread.id});expect(closeDesktop).toHaveBeenCalledWith(thread.id);expect(actions()).toEqual(['close']);
 expect(await harness.behavior.callRpc('getBrowserView',{threadId:thread.id})).toEqual({kind:'closed'});
});
it('keeps local live-view requests off VNC and uses attention for manual actions',async()=>{
 const openDesktop=vi.fn(async()=>null),closeDesktop=vi.fn(async()=>{});const {harness,thread,start}=setup({openDesktop,closeDesktop});
 expect(await harness.behavior.callAgentTool('browser_live',{action:'open'},{threadId:thread.id})).toContain('local');expect(openDesktop).not.toHaveBeenCalled();
 const done=start();await vi.waitFor(()=>expect(harness.pendingInteractions).toHaveLength(1));expect(harness.pendingInteractions[0].payload).toMatchObject({inlineViewer:false});expect(harness.pendingInteractions[0].payload).not.toHaveProperty('viewerUrl');harness.behavior.submitInteraction(harness.pendingInteractions[0].id,{done:true});await done;
});
it('revokes watching before an interactive inline handoff and prevents watch reopening while pending',async()=>{
 const order:string[]=[],openDesktop=vi.fn(async(_host:string,_thread:string,watch?:boolean)=>{order.push(watch?'watch':'interact');return 'https://sandbox--1234.getbb.app/#grant';}),closeDesktop=vi.fn(async()=>{order.push('close');});
 const {harness,thread,start}=setup({openDesktop,closeDesktop},true);await harness.behavior.callRpc('openBrowserView',{threadId:thread.id});
 const result=start();await vi.waitFor(()=>expect(harness.pendingInteractions).toHaveLength(1));expect(order).toEqual(['watch','close','interact']);expect(harness.pendingInteractions[0].payload).toMatchObject({inlineViewer:true});
 expect(await harness.behavior.callRpc('openBrowserView',{threadId:thread.id})).toEqual({kind:'handoff'});expect(openDesktop).toHaveBeenCalledTimes(2);
 harness.behavior.submitInteraction(harness.pendingInteractions[0].id,{done:true});await result;
});
it('expires live viewing and cleans an idle browser',async()=>{
 vi.useFakeTimers();
 try{
  const openDesktop=vi.fn(async()=> 'https://sandbox--1234.getbb.app/#grant'),closeDesktop=vi.fn(async()=>{});const {harness,thread,actions}=setup({openDesktop,closeDesktop},true);
  await harness.behavior.callRpc('openBrowserView',{threadId:thread.id});await harness.behavior.emitThreadEvent('thread.idle',{thread,lastAssistantText:'Watching'});
  await vi.advanceTimersByTimeAsync(15*60_000+10_000);expect(closeDesktop).toHaveBeenCalledWith(thread.id);expect(actions()).toEqual(['close']);expect(await harness.behavior.callRpc('getBrowserView',{threadId:thread.id})).toEqual({kind:'closed'});
 }finally{vi.useRealTimers();}
});

it("returns a reply as user direction and preserves the session without claiming completion", async () => {
  const { harness, start, actions } = setup();
  const result = start();
  await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
  harness.behavior.submitInteraction(harness.pendingInteractions[0].id, { reply: "Use the other account instead; I have not signed in." });
  const response = await result;
  expect(response).toContain("Use the other account instead; I have not signed in.");
  expect(response).toContain("not confirmed complete");
  expect(response).not.toContain("Take a fresh bb-browser snapshot");
  expect(actions()).toEqual(["pause", "resume"]);
});

it("does not accept empty or oversized replies as completion", async () => {
  for (const reply of ["   ", "x".repeat(4001)]) {
    const { harness, start, actions } = setup();
    const result = start();
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    harness.behavior.submitInteraction(harness.pendingInteractions[0].id, { reply });
    expect(await result).toMatchObject({ isError: true });
    expect(actions()).toEqual(["pause", "discard"]);
  }
});
