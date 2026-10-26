import { describe, expect, it } from "vitest";
import { checkApp, lintApp } from "./app-lint.js";

describe("app author checks", () => {
  it("checks classic script syntax without executing scripts", () => {
    const scope = globalThis as Record<string, unknown>;
    const result = checkApp('<script>globalThis.__pagesCheckerExecuted = true;</script>');
    expect(result.ok).toBe(true);
    expect(scope.__pagesCheckerExecuted).toBeUndefined();
    expect(checkApp('<script>const broken = ;</script>').ok).toBe(false);
    expect(checkApp('<script>await Promise.resolve();</script>').ok).toBe(false);
  });

  it("rejects resource loads while preserving inline assets and ordinary literals", () => {
    expect(checkApp('<img src="https://example.com/image.png"><script>fetch("/data")</script>').ok).toBe(false);
    expect(checkApp('<img src="data:image/png;base64,AA=="><script>const label = "fetch(https://example.com)";</script>').ok).toBe(true);
  });

  it("warns about self-navigation without claiming it is prevented", () => {
    const findings = lintApp('<script>location.href = "https://example.com";</script>');
    expect(findings).toEqual([expect.objectContaining({ severity: "warning" })]);
    expect(checkApp('<script>location.replace("https://example.com");</script>').ok).toBe(true);
  });
});
