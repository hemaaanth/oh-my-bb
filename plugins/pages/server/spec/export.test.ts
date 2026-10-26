import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { exportMarkdown } from "./export.js";

const host = () => createFakePluginHost({ pluginId: "pages" }).bb;

describe("Markdown document export", () => {
  it("preserves prose and unrelated code while rendering Pages fences with supplied state", async () => {
    const source = ['Before.', '', '~~~~openui-lang', '$count = 2', 'root = Stat("Count", $count)', '~~~~', '', '```js', 'root = Text("ordinary code");', '```', '', 'After.'].join('\n');
    const result = await exportMarkdown(host(), "thr_fixture", source, { $count: 9 });
    expect(result).toContain('Before.\n\nCount **9**');
    expect(result).toContain('```js\nroot = Text("ordinary code");\n```');
    expect(result).toContain('After.');
    expect(result).not.toContain('Count **2**');
  });

  it("does not reinterpret an interrupted UI fence as completed output", async () => {
    const source = 'Before.\n\n```openui-lang\nroot = Stat("Count", 2)';
    expect(await exportMarkdown(host(), "thr_fixture", source)).toBe(source);
  });

  it("reports malformed standalone components instead of returning empty success", async () => {
    await expect(exportMarkdown(host(), "thr_fixture", 'root = Missing("x")', {}, true)).rejects.toThrow();
  });
});
