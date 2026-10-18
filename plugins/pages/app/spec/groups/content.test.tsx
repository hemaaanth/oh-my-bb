import { describe, expect, it } from "vitest";
import { iconFor, imageUrl, listRows, pairsOf, webUrl } from "./content.js";

describe("content helpers", () => {
  it("allows only http(s) web links", () => {
    expect(webUrl("https://example.com/a")?.host).toBe("example.com");
    expect(webUrl(" http://x.io ")?.href).toBe("http://x.io/");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "src/a.ts", "", 3, undefined]) expect(webUrl(bad)).toBeNull();
  });

  it("allows http(s) and data: images only", () => {
    expect(imageUrl("https://a.b/c.png")).toBe("https://a.b/c.png");
    expect(imageUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    for (const bad of ["data:text/html,<b>", "javascript:x", "/tmp/a.png", null]) expect(imageUrl(bad)).toBeNull();
  });

  it("reads pairs from objects and arrays, tolerating partial rows", () => {
    expect(pairsOf({ A: 1, B: null })).toEqual([["A", 1], ["B", null]]);
    expect(pairsOf([["A", "x"], ["B"], [], "junk"])).toEqual([["A", "x"], ["B", null]]);
    expect(pairsOf({ type: "element", typeName: "Badge" })).toEqual([]);
    expect(pairsOf(undefined)).toEqual([]);
  });

  it("matches icon names loosely and rejects unknown ones", () => {
    expect(iconFor("git-pull-request")).toBe(iconFor("GitPullRequest"));
    expect(iconFor("map pin")).toBeDefined();
    expect(iconFor("NotAnIcon")).toBeUndefined();
    expect(iconFor(7)).toBeUndefined();
  });

  it("nests a List under the item before it", () => {
    const sub = { type: "element", typeName: "List" };
    expect(listRows(["a", sub, "b", null])).toEqual([{ head: "a", nested: [sub] }, { head: "b", nested: [] }]);
    expect(listRows([sub])).toEqual([{ head: sub, nested: [] }]);
  });
});
