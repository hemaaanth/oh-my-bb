import { describe, expect, it } from "vitest";
import { renderCursorPrompt } from "./cursor-composer.js";

describe("Cursor Composer request adapter", () => {
  it("keeps the Responses conversation and exposes only client tools", () => {
    const result = renderCursorPrompt({
      model: "composer-2.5",
      instructions: "Be concise.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Check it." }] },
        { type: "function_call", name: "read_marker", call_id: "call_1", arguments: "{\"id\":1}" },
        { type: "function_call_output", call_id: "call_1", output: "ready" },
      ],
      tools: [{ type: "function", name: "read_marker", description: "Read one marker", parameters: { type: "object" } }],
      stream: true,
    });
    expect(result.streaming).toBe(true);
    expect(result.tools).toEqual([{ name: "read_marker", description: "Read one marker", inputSchema: { type: "object" } }]);
    expect(result.prompt).toContain("Instructions:\nBe concise.");
    expect(result.prompt).toContain("user: Check it.");
    expect(result.prompt).toContain("assistant tool call read_marker (call_1): {\"id\":1}");
    expect(result.prompt).toContain("tool result (call_1): ready");
  });
});
