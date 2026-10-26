// GLSL boundary cases ported from GenUI core/glsl-check.test.ts (Apache-2.0).
import { describe, expect, it } from "vitest";
import { checkShader } from "./glsl-check.js";

const pass = (code: string) => [{ name: "image", code }];
describe("shader author validation", () => {
  it("accepts Shadertoy uniforms and named inputs", () => {
    expect(checkShader(pass("void mainImage(out vec4 c, in vec2 p) { c = vec4(sin(iTime * speed), p / iResolution.xy, 1.0); }"), ["speed"], 0)).toEqual([]);
  });

  it("detects missing buffers and textures rather than rendering black", () => {
    expect(checkShader(pass("void mainImage(out vec4 c, in vec2 p) { c = texture(iChannel1, p); }"), [], 0).some((error) => error.includes("iChannel1"))).toBe(true);
    expect(checkShader(pass("void mainImage(out vec4 c, in vec2 p) { c = texture(iTexture0, p); }"), [], 0).some((error) => error.includes("iTexture0"))).toBe(true);
    expect(checkShader(pass("void mainImage(out vec4 c, in vec2 p) { c = texture(iTexture0, p); }"), [], 1)).toEqual([]);
  });

  it("reports a syntax error at the agent's pass line, not the generated uniform header", () => {
    const errors = checkShader(pass("void mainImage(out vec4 c, in vec2 p) {\n c = vec4(1.0)\n}"), [], 0);
    expect(errors.some((error) => /image, line [23]:/u.test(error))).toBe(true);
  });

  it("rejects reserved uniforms and oversized input sets before compilation", () => {
    const code = pass("void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }");
    expect(checkShader(code, ["iTime"], 0).some((error) => error.includes("iTime"))).toBe(true);
    expect(checkShader(code, Array.from({ length: 17 }, (_, i) => `value${i}`), 0).some((error) => error.includes("16"))).toBe(true);
  });
});
