import { expect, it } from "vitest";
import { buildPiSessionParams, buildPiTurnOptions } from "./session-params";

it("refuses an initial session when required agent setup failed", () => {
  expect(() => buildPiSessionParams({
    threadId: "th_1", cwd: "/work", instructionMode: "append",
    options: { envVars: { AGENT_SETUP_ERROR: "Security tools setup failed: download checksum mismatch" } },
  })).toThrow("download checksum mismatch");
});

it("refuses a follow-up turn when required agent setup failed", () => {
  expect(() => buildPiTurnOptions({ envVars: { AGENT_SETUP_ERROR: "Security tools setup failed: uv unavailable" } }))
    .toThrow("uv unavailable");
});

it("keeps ordinary sessions and turns available", () => {
  expect(buildPiTurnOptions({ model: "model-gateway/gpt-6.1-sol" }).model).toBe("model-gateway/gpt-6.1-sol");
  expect(buildPiSessionParams({ threadId: "th_1", cwd: "/work", instructionMode: "append", options: {} }).cwd).toBe("/work");
});
