import path from "node:path";
import { cliCommand, PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PagesCliCommands } from "../../cli.js";
import { specTools } from "../../app/spec/tools.js";
import { checkApp, MAX_APP_CHARS } from "./app-lint.js";
import { checkOpenUi, MAX_SPEC_CHARS, parseCheckedSpec, type SpecCheck, type SpecIssue } from "./check.js";
import { runTool } from "./data.js";
import { literal } from "./evaluate.js";
import examples from "./examples.json";
import { sourcedQuery } from "../../app/spec/source-metadata.js";
import { exportMarkdown } from "./export.js";

type Language = "openui-lang" | "app";
export type AuthorCheck = ({ language: "openui-lang" } & SpecCheck) | { language: "app"; ok: boolean; report: string };
const queryTools = new Set(specTools.map(({ name }) => name));
const MAX_QUERIES = 16;
const languageSchema = z.enum(["openui-lang", "app"]);

/** Checks never execute app scripts, publish a page, or send a reply. */
export async function checkSource(bb: BbPluginApi, threadId: string | undefined, code: string, language: Language): Promise<AuthorCheck> {
  if (language === "app") return { language, ...checkApp(code) };
  if (code.length > MAX_SPEC_CHARS) return { language, ...checkOpenUi(code) };
  let parsed;
  try { parsed = parseCheckedSpec(code); }
  catch (error) { return { language, ok: false, checks: 0, issues: [{ severity: "error", kind: "parse", message: error instanceof Error ? error.message : String(error) }] }; }
  const queries = new Map<string, unknown>();
  const issues: SpecIssue[] = [];
  let loaded = 0;
  for (const query of parsed.queryStatements) {
    const tool = literal(query.toolAST);
    const args = query.argsAST ? literal(query.argsAST) : {};
    if (typeof tool !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
      issues.push({ severity: "warning", kind: "probe", component: "Query", message: "A dynamic Query was checked with its declared default, not fetched." });
      continue;
    }
    if (!queryTools.has(tool)) {
      issues.push({ severity: "error", kind: "runtime", component: "Query", message: `Unknown Query tool ${JSON.stringify(tool)}.` });
      continue;
    }
    if (loaded >= MAX_QUERIES) {
      issues.push({ severity: "warning", kind: "probe", component: "Query", message: `Fetched the first ${MAX_QUERIES} queries. Remaining queries use their defaults.` });
      break;
    }
    loaded++;
    try { queries.set(query.statementId, sourcedQuery(tool, args as Record<string, unknown>, await runTool(bb, { threadId, tool, args: args as Record<string, unknown> }))); }
    catch (error) { issues.push({ severity: "error", kind: "runtime", component: "Query", message: `Query(${JSON.stringify(tool)}): ${error instanceof Error ? error.message : String(error)}` }); }
  }
  const checked = checkOpenUi(code, queries, parsed);
  return { language, ...checked, ok: checked.ok && !issues.some(({ severity }) => severity === "error"), issues: [...issues, ...checked.issues] };
}

export function findExamples(names: readonly string[] = []) {
  const wanted = names.map((name) => name.toLowerCase());
  return examples.filter((entry) => !wanted.length || wanted.some((name) => entry.name.toLowerCase() === name || entry.group.toLowerCase() === name));
}

function textReport(result: AuthorCheck): string {
  if (result.language === "app") return result.report;
  return [`${result.ok ? "Passed" : "Failed"}: ${result.checks} default and independent input-state checks.`, ...result.issues.map((issue) => `${issue.severity}: ${issue.component ? `${issue.component}: ` : ""}${issue.state ? `[${issue.state}] ` : ""}${issue.message}`), "This is a static check, not a browser rendering or full state-combination test."].join("\n");
}

export function registerAuthoring(bb: BbPluginApi): PagesCliCommands {
  bb.agents.registerTool({
    name: "page_check",
    description: "Check an openui-lang program or app HTML before replying. Checks OpenUI parse/evaluation, independent input boundaries, scenes, GLSL, or app script syntax and sandbox mistakes. Reads literal Query sources in the calling thread, at most 16. Does not execute app JavaScript, render a browser, publish, or send answers. Not a security proof or exhaustive interaction test.",
    presentation: { label: { pending: "Checking UI", completed: "Checked UI" }, icon: { glyph: "FileText" } },
    parameters: z.object({ code: z.string().max(Math.max(MAX_APP_CHARS, MAX_SPEC_CHARS)), language: languageSchema.default("openui-lang") }).strict(),
    async execute({ code, language }, { threadId }) { return JSON.stringify(await checkSource(bb, threadId, code, language)); },
  });
  bb.agents.registerTool({
    name: "page_examples",
    description: "Get Pages component signatures and working OpenUI examples by component or group name. With no names, list the catalog. Examples use illustrative data; replace Query paths with files that exist in the calling thread. App HTML runs only after its fence closes. Its opaque sandbox blocks fetch and remote resources, but same-frame navigation can still make a network request.",
    presentation: { label: { pending: "Reading UI examples", completed: "Read UI examples" }, icon: { glyph: "FileText" } },
    parameters: z.object({ names: z.array(z.string().min(1).max(80)).max(16).default([]) }).strict(),
    execute({ names }) {
      const matched = findExamples(names);
      return JSON.stringify(names.length ? { components: matched, missing: names.filter((name) => !findExamples([name]).length) } : { components: matched.map(({ name, group, description, signature }) => ({ name, group, description, signature })) });
    },
  });
  return {
    render: cliCommand({
      summary: "Export Pages UI as Markdown, preserving surrounding prose",
      positionals: [{ name: "path", description: "OpenUI or Markdown source file; omit for this thread's latest assistant output" }],
      options: { state: { type: "string", description: "Native form/state snapshot as a JSON object; defaults to the source's initial values" } },
      async run({ positionals, options }, ctx) {
        if (!ctx.threadId) throw new PluginCliError("Run this command from a BB thread.", { code: "thread_required" });
        let state: Record<string, unknown> = {};
        if (options.state !== undefined) {
          let value: unknown;
          try { value = JSON.parse(options.state); } catch { throw new PluginCliError("--state must be a JSON object.", { code: "invalid_state" }); }
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new PluginCliError("--state must be a JSON object.", { code: "invalid_state" });
          state = value as Record<string, unknown>;
        }
        const file = positionals.path ? (ctx.cwd ? path.posix.resolve(ctx.cwd, positionals.path) : positionals.path) : null;
        const source = file ? await runTool(bb, { threadId: ctx.threadId, tool: "read_text", args: { path: file } }) : (await bb.sdk.threads.output({ threadId: ctx.threadId })).output;
        if (typeof source !== "string") throw new PluginCliError("No assistant output is available to export.", { code: "no_output" });
        let output: string;
        try { output = await exportMarkdown(bb, ctx.threadId, source, state, file !== null && !/\.(?:md|markdown)$/iu.test(file)); }
        catch (error) { throw new PluginCliError(error instanceof Error ? error.message : "Could not export Markdown.", { code: "render_failed" }); }
        if (Buffer.byteLength(output, "utf8") > PLUGIN_CLI_OUTPUT_MAX_BYTES) throw new PluginCliError("The Markdown exceeds the CLI output limit. Export a smaller source file.", { code: "output_too_large" });
        return { exitCode: 0, stdout: output };
      },
    }),
    check: cliCommand({
      summary: "Check an OpenUI source file or sandboxed app HTML without publishing",
      positionals: [{ name: "path", required: true, description: "A source file in the workspace, thread storage, or /tmp" }],
      options: {
        language: { type: "enum", values: ["openui-lang", "app"] as const, description: "Default: app for .html/.htm, otherwise openui-lang" },
        json: { type: "boolean", description: "Emit machine-readable results" },
      },
      async run({ positionals, options }, ctx) {
        if (!ctx.threadId) throw new PluginCliError("Run this command from a BB thread.", { code: "thread_required" });
        const file = ctx.cwd ? path.posix.resolve(ctx.cwd, positionals.path) : positionals.path;
        const code = await runTool(bb, { threadId: ctx.threadId, tool: "read_text", args: { path: file } });
        const result = await checkSource(bb, ctx.threadId, code as string, options.language ?? (/\.html?$/iu.test(file) ? "app" : "openui-lang"));
        return { exitCode: result.ok ? 0 : 1, stdout: options.json ? JSON.stringify(result, null, 2) : textReport(result) };
      },
    }),
    examples: cliCommand({
      summary: "List component signatures or read examples for a component or group",
      positionals: [{ name: "name", description: "Component or group name; omit to list the catalog" }],
      options: { json: { type: "boolean", description: "Emit machine-readable examples" } },
      run({ positionals, options }) {
        const name = positionals.name;
        const found = findExamples(name ? [name] : []);
        if (name && !found.length) throw new PluginCliError(`No component or group named ${JSON.stringify(name)}. Run bb pages examples to list them.`, { code: "not_found" });
        return { exitCode: 0, stdout: options.json ? JSON.stringify(found, null, 2) : found.map((entry) => `${entry.name} (${entry.group})\n${entry.signature}${name ? `\n${entry.examples.map((example) => `${example.name}\n${example.code}`).join("\n\n")}` : ""}`).join("\n\n") };
      },
    }),
  };
}
