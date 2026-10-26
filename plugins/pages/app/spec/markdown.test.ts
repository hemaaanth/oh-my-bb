import { describe, expect, it } from "vitest";
import { createParser, type LibraryJSONSchema } from "@openuidev/lang-core";
import schema from "../../server/spec/library.schema.json";
import { snapshotMarkdown } from "./markdown.js";
import { annotateSources, sourcedQuery } from "./source-metadata.js";

const parser = createParser(schema as unknown as LibraryJSONSchema);

describe("native current-value Markdown", () => {
  it("exports changed bound values and derived numbers rather than source defaults", () => {
    const parsed = parser.parse('$amount = 2\nroot = Stack([Slider("amount", 1, 10, 1, "Amount", $amount), Stat("Total", $amount * 10)])');
    const result = snapshotMarkdown(parsed, { state: { $amount: 7 } });
    expect(result).toContain("Amount: 7");
    expect(result).toContain("Total **70**");
    expect(result).not.toContain("Total **20**");
  });

  it("keeps edited values isolated by their owning form", () => {
    const parsed = parser.parse('root = Stack([Form("first", [Input("note", "First note")], [Button("Save")]), Form("second", [Input("note", "Second note")], [Button("Save")])])');
    const result = snapshotMarkdown(parsed, { state: { first: { note: { value: "Alpha", componentType: "Input" } }, second: { note: { value: "Beta", componentType: "Input" } } } });
    expect(result).toContain("First note: Alpha");
    expect(result).toContain("Second note: Beta");
    expect(result).not.toContain("First note: Beta");
  });

  it("uses the changed file query arguments and keeps its source caption", () => {
    const parsed = parser.parse('$file = "old.json"\ndata = Query("file", {path: $file})\nroot = Table(data.columns, data.rows)');
    annotateSources(parsed);
    const requested: unknown[] = [];
    const result = snapshotMarkdown(parsed, { state: { $file: "new.json" }, resolveQuery: (tool, args) => {
      requested.push([tool, args]);
      return sourcedQuery(tool, args, { columns: ["Name", "Value"], rows: [["A|B", 42]] });
    } });
    expect(requested).toEqual([["file", { path: "new.json" }]]);
    expect(result).toContain("| A\\|B | 42 |");
    expect(result).toContain("new.json");
    expect(result).not.toContain("old.json");
  });

  it("exports only the requested source lines and contains embedded backticks", () => {
    const parsed = parser.parse('root = FileCode("note.md", 2, 3)');
    const result = snapshotMarkdown(parsed, { textFiles: new Map([["note.md", "omit\n```js\nconst x = 1;\nomit too\n"]]) });
    expect(result).toContain("````md\n```js\nconst x = 1;\n````");
    expect(result).not.toContain("omit");
  });

  it("refuses to turn a missing query result into a plausible empty table", () => {
    const parsed = parser.parse('data = Query("file", {path:"missing.json"})\nroot = Table(data.columns, data.rows)');
    expect(() => snapshotMarkdown(parsed, { resolveQuery: () => { throw new Error("Data is still loading."); } })).toThrow("Data is still loading");
  });
});
