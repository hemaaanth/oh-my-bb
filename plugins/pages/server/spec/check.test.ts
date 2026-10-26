import { describe, expect, it } from "vitest";
import { checkOpenUi } from "./check.js";

describe("bound-state author checks", () => {
  it("finds a scene failure that appears only at a slider endpoint", () => {
    const code = '$gain = 1\nroot = Stack([Slider("gain", 0, 3, 1, "Gain", $gain), Scene([{shape: "surface", x: [0, 1], z: [0, 1], detail: 2, f: "@Sqrt(" + $gain + " - 1)"}], 120)])';
    const checked = checkOpenUi(code);
    expect(checked.ok).toBe(false);
    expect(checked.issues.some((issue) => issue.kind === "scene" && issue.state?.includes("$gain=0"))).toBe(true);
    expect(checked.issues.filter((issue) => issue.state?.startsWith("default"))).toEqual([]);
  });

  it("checks option values, not their display labels, for conditional shader code", () => {
    const valid = "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }";
    const broken = "void mainImage(out vec4 c, in vec2 p) { c = vec4(typo); }";
    const code = `$mode = "good"\nroot = Stack([Choice("mode", [{label: "Good", value: "good"}, {label: "Broken", value: "bad"}], "Mode", false, $mode), Shader($mode == "good" ? ${JSON.stringify(valid)} : ${JSON.stringify(broken)})])`;
    const checked = checkOpenUi(code);
    expect(checked.ok).toBe(false);
    expect(checked.issues.some((issue) => issue.kind === "shader" && issue.state === '$mode="bad"' && issue.message.includes("typo"))).toBe(true);
    expect(checked.issues.some((issue) => issue.kind === "shader" && issue.state === undefined)).toBe(false);
  });
});
