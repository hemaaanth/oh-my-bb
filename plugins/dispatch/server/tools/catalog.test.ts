import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../../shared/tool-names.js";
import { loadPlugin, makeContext, pluginRow } from "../core-test-host.js";
import { writePreferences } from "../preferences.js";
import { buildCatalog, type CatalogFlags } from "./catalog.js";
import { toolCatalog } from "./index.js";
import { allowedByAccess, commandPlugins, exposedPlugins, hasUsableCommand, type PluginRow } from "./plugins.js";

const DESKTOP: CatalogFlags = { mobile: false, canNavigate: true, channel: "app", allowedPluginIds: [] };
const MOBILE: CatalogFlags = { ...DESKTOP, mobile: true };
const PHONE: CatalogFlags = { mobile: false, canNavigate: false, channel: "phone", allowedPluginIds: [] };

const names = (flags: CatalogFlags) => buildCatalog(flags).map((tool) => tool.name);
const tool = (flags: CatalogFlags, name: string) => buildCatalog(flags).find((entry) => entry.name === name)!;
const props = (flags: CatalogFlags, name: string) => Object.keys((tool(flags, name).parameters as { properties: object }).properties);
const without = (...left: string[]) => TOOL_NAMES.filter((name) => name !== "run_plugin_command" && !left.includes(name));

describe("tool catalog variants (CONTRACTS §2)", () => {
  it("desktop has every tool except the mobile drawer tools", () => {
    expect(names(DESKTOP)).toEqual(without("focus_threads", "manage_views", "set_view_behavior"));
  });

  it("mobile adds the drawer tools", () => {
    expect(names(MOBILE)).toEqual(without());
  });

  it("phone drops the mobile tools and the app-only tools", () => {
    expect(names(PHONE)).toEqual(
      without("focus_threads", "manage_views", "set_view_behavior", "set_pane", "set_composer_text", "append_composer_text"),
    );
  });

  it("keeps TOOL_NAMES order and a strict object schema for every tool", () => {
    const all = buildCatalog({ ...MOBILE, allowedPluginIds: ["notes"] });
    expect(all.map((entry) => entry.name)).toEqual([...TOOL_NAMES]);
    for (const entry of all) {
      expect(entry.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(Array.isArray((entry.parameters as { required: unknown }).required)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(10);
    }
  });

  it("shapes focus_thread and send_to_thread by device", () => {
    expect(props(DESKTOP, "focus_thread")).toEqual(["thread_id", "split"]);
    expect(props(MOBILE, "focus_thread")).toEqual(["thread_id", "disposition", "beside"]);
    expect(props({ ...MOBILE, canNavigate: false }, "focus_thread")).toEqual(["thread_id", "disposition"]);
    expect(props(PHONE, "focus_thread")).toEqual(["thread_id"]);
    expect(props(DESKTOP, "send_to_thread")).toEqual(["thread_id", "message", "quiet"]);
    expect(props({ ...DESKTOP, canNavigate: false }, "send_to_thread")).toEqual(["thread_id", "message"]);
    expect(props(PHONE, "send_to_thread")).toEqual(["thread_id", "message"]);
  });

  it("says where each tool runs", () => {
    expect(tool(DESKTOP, "get_context").runsOn).toBe("app");
    expect(tool(DESKTOP, "start_thread").runsOn).toBe("both");
    expect(tool(DESKTOP, "list_threads").runsOn).toBe("server");
    expect(buildCatalog(PHONE).every((entry) => entry.runsOn === "server")).toBe(true);
  });

  it("limits list_threads to the contract numbers", () => {
    const limit = (tool(DESKTOP, "list_threads").parameters as { properties: { limit: object } }).properties.limit;
    expect(limit).toMatchObject({ default: 15, maximum: 100 });
  });

  it("offers run_plugin_command with the allowed ids as the enum, and only then", () => {
    const run = tool({ ...DESKTOP, allowedPluginIds: ["notes", "todo"] }, "run_plugin_command");
    expect((run.parameters as { properties: { plugin_id: { enum: string[] } } }).properties.plugin_id.enum).toEqual(["notes", "todo"]);
    expect(names(DESKTOP)).not.toContain("run_plugin_command");
  });
});

describe("plugin exposure", () => {
  const rows = [
    pluginRow(),
    pluginRow({ id: "todo", name: "Todo", cliCommand: { name: "todo", summary: "" } }),
    pluginRow({ id: "off", name: "Off", enabled: false }),
    pluginRow({ id: "broken", name: "Broken", status: "error" }),
    pluginRow({ id: "quiet", name: "Quiet", cliCommand: null }),
    pluginRow({ id: "dispatch", name: "Dispatch", cliCommand: { name: "dispatch", summary: "" } }),
  ] as unknown as PluginRow[];

  it("keeps enabled, running plugins with a CLI that are not Dispatch", () => {
    expect(rows.filter(hasUsableCommand).map((row) => row.id)).toEqual(["notes", "todo"]);
    expect(commandPlugins(rows)).toEqual([
      { id: "notes", name: "Notes", command: "notes", summary: "Read and write notes" },
      { id: "todo", name: "Todo", command: "todo", summary: "" },
    ]);
  });

  it("applies the all, none, and selected access modes", () => {
    expect(exposedPlugins(rows, { mode: "all" }).map((plugin) => plugin.id)).toEqual(["notes", "todo"]);
    expect(exposedPlugins(rows, { mode: "none" })).toEqual([]);
    expect(exposedPlugins(rows, { mode: "selected", ids: ["todo", "off"] }).map((plugin) => plugin.id)).toEqual(["todo"]);
    expect(allowedByAccess("x", { mode: "selected", ids: [] })).toBe(false);
  });

  it("builds the session catalog from preferences and the live plugin list", async () => {
    const { ctx } = await makeContext(undefined, { plugins: { list: async () => ({ plugins: rows }) } });
    await writePreferences(ctx, { pluginAccess: { mode: "selected", ids: ["notes"] } });
    const tools = await toolCatalog(ctx, { mobile: false, canNavigate: true, channel: "app" });
    const run = tools.find((entry) => entry.name === "run_plugin_command")!;
    expect((run.parameters as { properties: { plugin_id: { enum: string[] } } }).properties.plugin_id.enum).toEqual(["notes"]);
    await writePreferences(ctx, { pluginAccess: { mode: "none" } });
    expect((await toolCatalog(ctx, { mobile: false, canNavigate: true, channel: "app" })).map((entry) => entry.name)).not.toContain(
      "run_plugin_command",
    );
  });

  it("serves the plugin list over RPC", async () => {
    const { harness } = await loadPlugin(undefined, { plugins: { list: async () => ({ plugins: rows }) } });
    const { plugins } = (await harness.callRpc("pluginsWithCommands", {})) as { plugins: Array<{ id: string }> };
    expect(plugins.map((plugin) => plugin.id)).toEqual(["notes", "todo"]);
  });
});
