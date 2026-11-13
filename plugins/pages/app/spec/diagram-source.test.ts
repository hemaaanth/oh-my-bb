import { render } from "pele";
import { describe, expect, it } from "vitest";
import { diagramGraph, diagramSource } from "./diagram-source.js";

describe("diagramGraph", () => {
  it("keeps the first node per id, defaults labels, and drops edges to unknown nodes", () => {
    const { nodes, edges } = diagramGraph(
      [{ id: "a" }, { id: "a", label: "Again" }, { id: "b", label: "Bee", tone: "success" }, { id: "c", tone: "loud" }, { label: "no id" }, null],
      [{ from: "a", to: "b", label: "go" }, { from: "b", to: "zz" }, { from: "c", to: "a" }, "junk"],
    );
    expect(nodes).toEqual([{ id: "a", label: "a", tone: "neutral" }, { id: "b", label: "Bee", tone: "success" }, { id: "c", label: "c", tone: "neutral" }]);
    expect(edges).toEqual([{ from: "a", to: "b", label: "go" }, { from: "c", to: "a", label: undefined }]);
  });
});

describe("diagramSource", () => {
  it("writes a flowchart with safe ids, quoted labels, and tone classes", () => {
    const { nodes, edges } = diagramGraph([{ id: "end", label: 'Say "hi"\n  now' }, { id: "a b", tone: "danger" }], [{ from: "end", to: "a b", label: "x|y" }]);
    expect(diagramSource(nodes, edges, true)).toBe(['flowchart LR', '  n0["Say #quot;hi#quot; now"]', '  n1["a b"]:::tone-danger', '  n0 -->|"x|y"| n1'].join("\n"));
    expect(diagramSource(nodes, [], false).split("\n")[0]).toBe("flowchart TD");
  });

  it("is text Pele draws, with the tone class on the node", () => {
    const { nodes, edges } = diagramGraph([{ id: "end", label: "End [1]" }, { id: "go", tone: "info" }], [{ from: "end", to: "go", label: "next" }]);
    const { svg, width, height } = render(diagramSource(nodes, edges, false), { idPrefix: "t", images: false });
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(svg).toContain("End [1]");
    expect(svg).toContain("next");
    expect(svg).toMatch(/class="[^"]*pele-node[^"]*tone-info/);
  });
});
