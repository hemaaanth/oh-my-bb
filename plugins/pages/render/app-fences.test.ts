// @vitest-environment jsdom
// @vitest-environment-options {"jsdom":{"runScripts":"dangerously"}}
import { createParser, type LibraryJSONSchema } from "@openuidev/lang-core";
import { describe, expect, it } from "vitest";
import schema from "../server/spec/library.schema.json";
import { renderMarkdown } from "./markdown.js";
import { specBlocks } from "./spec-baked.js";

const app = '<button>Run</button><script>window.__appRan = true;</script>';
describe("app fences in published Markdown", () => {
  it("keeps a closed quoted app's scripts inside the opaque app payload", () => {
    const page = renderMarkdown(`> \`\`\`app\n> ${app}\n> \`\`\``, { title: "App" });
    document.open();
    document.write(page);
    document.close();
    const blocks = specBlocks(page);
    expect(blocks).toHaveLength(1);
    const parsed = createParser(schema as unknown as LibraryJSONSchema).parse(blocks[0].code);
    expect(parsed.root?.typeName).toBe("App");
    expect(parsed.root?.props.html).toBe(`${app}\n`);
    expect((window as unknown as Record<string, unknown>).__appRan).toBeUndefined();
  });

  it("does not execute an unclosed app, even if its last line resembles a quoted closing marker", () => {
    const page = renderMarkdown(`\`\`\`app\n${app}\n> \`\`\``, { title: "App" });
    document.open();
    document.write(page);
    document.close();
    expect(specBlocks(page)).toEqual([]);
    expect(document.querySelector("code")?.textContent).toContain(app);
    expect((window as unknown as Record<string, unknown>).__appRan).toBeUndefined();
  });
});
