import { describe, expect, it } from "vitest";
import { locate, runTool, type ReadRoot } from "./data.js";
import { parseFile } from "./data-parse.js";
import { SpecError } from "./errors.js";

describe("parseFile", () => {
  it("parses by extension", () => {
    expect(parseFile("a.json", '﻿[{"x":1}]')).toMatchObject({ kind: "json", rows: [{ x: 1 }], data: [{ x: 1 }] });
    expect(parseFile("a.json", '{"x":1}')).toMatchObject({ kind: "json", rows: [], data: { x: 1 } });
    expect(parseFile("a.jsonl", '{"x":1}\n\n{"x":2}\n').rows).toEqual([{ x: 1 }, { x: 2 }]);
    expect(parseFile("a.csv", 'name,n,ok,note\n"Smith, J",007,true,\r\nAna,1.5,FALSE,"say ""hi"""\n').rows).toEqual([
      { name: "Smith, J", n: "007", ok: true, note: null },
      { name: "Ana", n: 1.5, ok: false, note: 'say "hi"' },
    ]);
    expect(parseFile("a.tsv", "a\tb\n1\tx\n").rows).toEqual([{ a: 1, b: "x" }]);
    expect(parseFile("notes.log", "hello")).toMatchObject({ kind: "text", rows: [], text: "hello" });
  });

  it("refuses malformed files with a SpecError", () => {
    expect(() => parseFile("a.json", "{")).toThrow(SpecError);
    expect(() => parseFile("a.jsonl", "{}\nnope")).toThrow(/line 2/u);
    expect(() => parseFile("a.csv", 'a\n"open')).toThrow(/never closes/u);
    expect(() => parseFile("a.csv", "a,a\n1,2")).toThrow(/twice/u);
    expect(() => parseFile("a.csv", "a\n1,2")).toThrow(/2 cells/u);
  });
});

describe("locate", () => {
  const roots: ReadRoot[] = [{ name: "workspace", rootPath: "/w/repo", hostId: "h" }, { name: "thread storage", rootPath: "/w/repo/.bb/store", hostId: "h" }, { name: "/tmp", rootPath: "/tmp", hostId: "h" }];

  it("resolves relative paths in the first root and absolute ones in the deepest root", () => {
    expect(locate(roots, "out/r.json")).toMatchObject({ root: roots[0], file: "out/r.json" });
    expect(locate(roots, "/w/repo/.bb/store/x.csv")).toMatchObject({ root: roots[1], file: "x.csv" });
    expect(locate(roots, "/tmp/a/../b.txt")).toMatchObject({ root: roots[2], file: "b.txt" });
  });

  it("refuses escapes", () => {
    for (const bad of ["", "../x", "a/../../x", "/etc/passwd", "/w/repo2/x", "/tmp", "/w/repo/../etc"]) expect(() => locate(roots, bad), bad).toThrow();
  });
});

describe("runTool", () => {
  const bb = { sdk: {} } as never;
  it("names unknown tools and needs a thread", async () => {
    await expect(runTool(bb, { tool: "nope", args: {} })).rejects.toThrow(/Unknown tool "nope"/u);
    await expect(runTool(bb, { tool: "commits", args: {} })).rejects.toThrow(/needs a thread/u);
  });
});
