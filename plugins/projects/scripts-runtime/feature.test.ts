import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import projects from "../server.js";
import host from "../host.js";
describe("Scripts consolidated in Projects", () => {
  it("preserves migrated approvals/autostart, exposes the command through Projects, and does not start work on load or reload", async () => {
    const h = createFakePluginHost({
      pluginId: "projects",
      sdk: { subscribe: () => () => {}, projects: { list: async () => [] } },
    });
    await h.bb.storage.kv.set("scripts:autostart", false);
    await h.bb.storage.kv.set("scripts:agent-setup:v1", {
      bindings: [],
      recipes: {},
    });
    await h.bb.storage.kv.set("scripts:service:retained", {
      terminalId: "retained-terminal",
      threadId: "old-thread",
    });
    await projects(h.bb);
    expect(
      await h.harness.behavior.callRpc("scriptsPreferences", null),
    ).toEqual({ autoStartServices: false });
    expect(
      await h.harness.behavior.callRpc("scripts_inspectMany", {
        threadIds: [],
      }),
    ).toEqual({});
    expect(
      await h.harness.behavior.runCli(["scripts", "agent-setup", "list"]),
    ).toMatchObject({ exitCode: 0 });
    expect(await h.bb.storage.kv.get("scripts:service:retained")).toEqual({
      terminalId: "retained-terminal",
      threadId: "old-thread",
    });
    expect(h.harness.inspection.sdk.callsTo("terminals.create")).toEqual([]);
    const reloaded = await h.harness.lifecycle.reload(projects);
    expect(
      await reloaded.harness.behavior.callRpc("scriptsPreferences", null),
    ).toEqual({ autoStartServices: false });
    expect(await reloaded.bb.storage.kv.get("scripts:agent-setup:v1")).toEqual({
      bindings: [],
      recipes: {},
    });
    expect(
      await reloaded.bb.storage.kv.get("scripts:service:retained"),
    ).toEqual({ terminalId: "retained-terminal", threadId: "old-thread" });
    expect(reloaded.harness.inspection.sdk.callsTo("terminals.create")).toEqual(
      [],
    );
    await reloaded.harness.lifecycle.dispose();
  });
  it("serves both environment and Scripts host methods from the single Projects host entry", async () => {
    const h = experimental_createHostEntryHarness(host);
    try {
      expect(await h.experimental_call("home", {})).toHaveProperty("home");
      expect(await h.experimental_call("allocate_port", {})).toEqual({
        port: expect.any(Number),
      });
    } finally {
      await h.experimental_dispose();
    }
  });
});

describe("independent group field updates", () => {
 it("keeps another client's rename when a stale colour editor saves", async () => {
  const h=createFakePluginHost({pluginId:"projects",sdk:{subscribe:()=>()=>{}}});
  await projects(h.bb);
  try {
   const group=await h.harness.behavior.callRpc("saveGroup",{name:"Original",color:"blue"}) as {id:string};
   await h.harness.behavior.callRpc("patchGroup",{id:group.id,name:"Renamed elsewhere"});
   const saved=await h.harness.behavior.callRpc("patchGroup",{id:group.id,color:"green"});
   expect(saved).toMatchObject({name:"Renamed elsewhere",color:"green"});
   await expect(h.harness.behavior.callRpc("patchGroup",{id:group.id,color:"rose"},{experimental_caller:{kind:"plugin",pluginId:"foreign"}})).rejects.toThrow("owner-client-required");
  } finally {await h.harness.lifecycle.dispose();}
 });
});

describe("Projects CLI help",()=>{
 it("explains both command families and never prepares a workspace for nested help",async()=>{
  const h=createFakePluginHost({pluginId:"projects",sdk:{subscribe:()=>()=>{}}});await projects(h.bb);
  try{
   expect(await h.harness.behavior.runCli(["--help"])).toMatchObject({exitCode:0,stdout:expect.stringContaining("bb projects scripts")});
   expect(await h.harness.behavior.runCli(["scripts","prepare","--help"])).toMatchObject({exitCode:0,stdout:expect.stringContaining("bb projects scripts prepare")});
   expect(h.harness.inspection.sdk.calls).toEqual([]);
   expect(h.harness.experimental_hostRpcCalls).toEqual([]);
  }finally{await h.harness.lifecycle.dispose();}
 });
});
