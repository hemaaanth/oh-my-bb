import type { PromptResult } from "./prompt-contract";

// The host also honors reveal=false. Reapply this at the server boundary so a
// future host parser cannot accidentally send prompt text to the app or CLI.
export function presentPrompt(result: PromptResult, reveal: boolean): PromptResult {
  if (reveal || !result.selected) return result;
  return { ...result, selected: {
    ...result.selected,
    system: result.selected.system.map((section) => ({ ...section, text: null })),
    injected: result.selected.injected.map((section) => ({ ...section, text: null })),
    tools: result.selected.tools.map((tool) => ({ ...tool, description: null, schema: null })),
  } };
}
