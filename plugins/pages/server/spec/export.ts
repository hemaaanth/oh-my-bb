import MarkdownIt from "markdown-it";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { SPEC_LANGUAGES } from "../../render/spec-baked.js";
import { snapshotMarkdown } from "../../app/spec/markdown.js";
import { specTools } from "../../app/spec/tools.js";
import { sourcedQuery } from "../../app/spec/source-metadata.js";
import { parseCheckedSpec, MAX_SPEC_CHARS } from "./check.js";
import { evaluateSpec, specElements } from "./evaluate.js";
import { runTool } from "./data.js";

const markdown = new MarkdownIt();
const allowedTools = new Set(specTools.map(tool => tool.name));
const MAX_READS = 16;

/** Resolves native read-only Queries in the caller's existing file/project scope. */
export async function exportOpenUi(bb: BbPluginApi, threadId: string, code: string, state: Record<string, unknown> = {}): Promise<string> {
  const parsed = parseCheckedSpec(code);
  const queries = new Map<string, unknown>();
  const textFiles = new Map<string, string>();
  let reads = 0;
  for (;;) {
    const needed: { current: { tool: string; args: Record<string, unknown>; id: string } | null } = { current: null };
    const evaluated = evaluateSpec(parsed, queries, state, (tool, args, id) => {
      needed.current = { tool, args, id };
      throw new Error("Waiting for a query.");
    });
    if (needed.current) {
      const { tool, args, id } = needed.current;
      if (!allowedTools.has(tool)) throw new Error(`Unknown Query tool ${JSON.stringify(tool)}.`);
      if (++reads > MAX_READS) throw new Error(`Markdown export accepts at most ${MAX_READS} data reads.`);
      const value = await runTool(bb, { threadId, tool, args });
      queries.set(id, sourcedQuery(tool, args, value));
      continue;
    }
    if (evaluated.errors.length) throw new Error(evaluated.errors.join("\n"));
    for (const element of specElements(evaluated.root)) {
      if (element.typeName !== "FileCode" || typeof element.props.file !== "string" || textFiles.has(element.props.file)) continue;
      if (++reads > MAX_READS) throw new Error(`Markdown export accepts at most ${MAX_READS} data reads.`);
      const text = await runTool(bb, { threadId, tool: "read_text", args: { path: element.props.file } });
      if (typeof text !== "string") throw new Error("The source excerpt is not text.");
      textFiles.set(element.props.file, text);
    }
    return snapshotMarkdown(parsed, { state, textFiles, resolveQuery: (_tool, _args, id) => queries.get(id) });
  }
}

/** Preserves prose and ordinary code fences; replaces only closed Pages UI fences. */
export async function exportMarkdown(bb: BbPluginApi, threadId: string, source: string, state: Record<string, unknown> = {}, standalone = false): Promise<string> {
  if (source.length > MAX_SPEC_CHARS) throw new Error(`Markdown export accepts at most ${MAX_SPEC_CHARS} characters.`);
  if (standalone) return exportOpenUi(bb, threadId, source, state);
  const lines = source.split(/(?<=\n)/u);
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1]! + line.length);
  const replacements: { start: number; end: number; content: string }[] = [];
  for (const token of markdown.parse(source, {})) {
    if (token.type !== "fence" || !token.map || !SPEC_LANGUAGES.some(lang => lang === token.info.trim().split(/\s/u)[0])) continue;
    const [from, to] = token.map;
    const finalLine = lines[to - 1]?.trim() ?? "";
    if (!new RegExp(`^${token.markup[0]}{${token.markup.length},}\\s*$`, "u").test(finalLine)) continue;
    replacements.push({ start: offsets[from]!, end: offsets[to] ?? source.length, content: (await exportOpenUi(bb, threadId, token.content, state)) + "\n" });
  }
  let output = source;
  for (const replacement of replacements.reverse()) output = output.slice(0, replacement.start) + replacement.content + output.slice(replacement.end);
  return output;
}
