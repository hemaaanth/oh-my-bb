// Result shape for the pinpoint_show agent tool: the annotation context as
// text plus one MCP-style image content part per stored screenshot. Pure
// data-in/data-out so the guaranteed pixels-on-the-tool-surface path (R9) is
// unit-testable without a live bb.
import type { StoredScreenshot } from "./store";

/** Mirrors the SDK's PluginAgentToolContentPart (kept local so lib code
 * stays free of the plugin-sdk dependency in tests). */
export type ToolContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function buildShowResult(
  text: string,
  screenshots: Pick<StoredScreenshot, "kind" | "mime" | "data">[],
): { content: ToolContentPart[] } {
  const content: ToolContentPart[] = [{ type: "text", text }];
  for (const shot of screenshots) {
    content.push({ type: "image", data: shot.data, mimeType: shot.mime });
  }
  return { content };
}
