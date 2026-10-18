import { describe, expect, it } from "vitest";
import { codeLanguage } from "./host.js";

describe("codeLanguage", () => {
  it("names the language from the extension", () => {
    expect(codeLanguage("snippet.ts")).toBe("TypeScript");
    expect(codeLanguage("deploy/app.YML")).toBe("YAML");
    expect(codeLanguage("step.rs")).toBe("Rust");
    expect(codeLanguage("example.openui")).toBe("openui-lang");
  });
  it("falls back to the extension, then the file name", () => {
    expect(codeLanguage("main.zig")).toBe("ZIG");
    expect(codeLanguage("Dockerfile")).toBe("Dockerfile");
    expect(codeLanguage(".env")).toBe(".env");
    expect(codeLanguage("")).toBe("Text");
  });
});
