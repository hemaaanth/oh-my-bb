import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { checkSource } from "./authoring.js";
import * as data from "./data.js";

const host = () => createFakePluginHost({ pluginId: "pages" }).bb;
const block = (code: string) => `<script type="text/openui-lang">${code}</script>`;
afterEach(() => vi.restoreAllMocks());

describe("HTML with embedded OpenUI", () => {
  it("rejects an unknown component even when the surrounding HTML passes", async () => {
    const result = await checkSource(host(), "thr_fixture", block('root = Missing("broken")'), "app");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ report: expect.stringContaining('Unknown component "Missing"') });
  });

  it("checks every block and identifies the failing block", async () => {
    const result = await checkSource(host(), "thr_fixture", block('root = Stat("Count", 2)') + block('root = Missing("broken")'), "app");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ report: expect.stringContaining("OpenUI block 2") });
  });

  it("accepts valid components without executing surrounding JavaScript", async () => {
    const result = await checkSource(host(), "thr_fixture", '<script>throw new Error("must not execute")</script>' + block('root = Stat("Count", 2)'), "app");
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ report: expect.stringContaining("OpenUI block 1") });
  });

  it("preserves JavaScript failures and ignores commented-out blocks", async () => {
    const result = await checkSource(host(), "thr_fixture", '<script>const broken = ;</script><!--' + block('root = Missing("ignored")') + '-->', "app");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ report: expect.not.stringContaining("Unknown component") });
  });

  it("shares the 16-read budget across embedded blocks in the caller's scope", async () => {
    const read = vi.spyOn(data, "runTool").mockResolvedValue({ text: "Loaded" });
    const bb = host();
    const html = Array.from({ length: 17 }, () => block('data = Query("file", {path: "/tmp/example.txt"}, {text: "Default"})\nroot = Text(data.text)')).join("\n");
    const result = await checkSource(bb, "thr_fixture", html, "app");
    expect(result.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(16);
    expect(read).toHaveBeenCalledWith(bb, { threadId: "thr_fixture", tool: "file", args: { path: "/tmp/example.txt" } });
    expect(result).toMatchObject({ report: expect.stringContaining("Remaining queries use their defaults") });
  });

  it("reports failed embedded data reads instead of accepting the default as proof", async () => {
    vi.spyOn(data, "runTool").mockRejectedValue(new Error("File not found"));
    const result = await checkSource(host(), "thr_fixture", block('data = Query("file", {path: "/tmp/missing"}, {text: "Default"})\nroot = Text(data.text)'), "app");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ report: expect.stringContaining("File not found") });
  });
});
