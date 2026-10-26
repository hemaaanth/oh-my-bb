import { describe, expect, it } from "vitest";
import { generateAccessCode } from "./access-code.js";

describe("generateAccessCode", () => {
  it("creates readable codes without repeating a fixed credential", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateAccessCode()));
    expect(codes.size).toBeGreaterThan(1);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
    }
  });
});
