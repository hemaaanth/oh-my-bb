import { describe, expect, it } from "vitest";
import { readPageAsset } from "./assets.js";

const theme = readPageAsset("theme.css").bytes.toString("utf8");
const rule = (selector: string) => theme.match(new RegExp(`:where\\(${selector.replace(/[.()]/g, "\\$&")}\\) \\{([^}]*)\\}`))?.[1] ?? "";

describe("theme one-line rules", () => {
  it("keeps column headers on one line", () => {
    expect(rule("thead th")).toContain("white-space: nowrap");
  });
  it("keeps a badge in one unbroken pill", () => {
    expect(rule(".badge")).toMatch(/display: inline-block;[\s\S]*white-space: nowrap/);
  });
});
