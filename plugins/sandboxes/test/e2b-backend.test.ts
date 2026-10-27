import { describe, expect, it } from "vitest";
import { parseE2bRuntimeOutput } from "../src/provider/backends/e2b.js";

describe("E2B runtime output", () => {
  it("accepts the final valid helper result after SDK status output", () => {
    expect(
      parseE2bRuntimeOutput(
        'connecting to sandbox\n{"action":"exec","exitCode":0,"stdout":"ok\\n","stderr":""}\n',
      ),
    ).toEqual({ action: "exec", exitCode: 0, stdout: "ok\n", stderr: "" });
  });

  it("rejects output without exposing it in the error", () => {
    const sensitive = "secret-provider-output";
    expect(() => parseE2bRuntimeOutput(sensitive)).toThrow(
      "E2B runtime returned invalid output (no JSON object; bytes=22)",
    );
    try {
      parseE2bRuntimeOutput(sensitive);
    } catch (error) {
      expect(String(error)).not.toContain(sensitive);
    }
  });
});
