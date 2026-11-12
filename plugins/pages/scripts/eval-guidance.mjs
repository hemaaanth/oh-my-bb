#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = { variant: "both", repeats: "1", "baseline-ref": "ae4efec0", provider: "claude-code" };
const allowed = new Set(["variant", "repeats", "baseline-ref", "model", "provider", "out", "case", "approved-route"]);
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  if (key === "dry-run") { options[key] = true; continue; }
  if (!process.argv[i].startsWith("--") || !allowed.has(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error(`Unknown/missing option ${process.argv[i]}`);
  options[key] = process.argv[++i];
}
if (!options.model || !options.out) throw new Error("Pass --model <approved Claude model> and --out <report directory>.");
if (/openrouter|grok|x-?ai/i.test(`${options.model} ${options.provider}`)) throw new Error("OpenRouter and xAI/Grok routes are prohibited; no fallback is available.");
if (process.env.ANTHROPIC_BASE_URL) {
  let hostname;
  try { hostname = new URL(process.env.ANTHROPIC_BASE_URL).hostname.toLowerCase().replace(/\.$/, ""); }
  catch { throw new Error("ANTHROPIC_BASE_URL must be an absolute URL for the approved route."); }
  if (hostname === "x.ai" || hostname.endsWith(".x.ai") || hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai") || hostname.includes("grok") || /openrouter|grok|x-?ai/i.test(process.env.ANTHROPIC_BASE_URL)) throw new Error("Prohibited provider in ANTHROPIC_BASE_URL");
}
if (!["claude", "claude-code"].includes(options.provider)) throw new Error("Only the local Claude Code CLI is supported.");
if (!["baseline", "new", "both"].includes(options.variant)) throw new Error("--variant must be baseline, new or both");
const repeats = Number(options.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
if (options["baseline-ref"].startsWith("-")) throw new Error("Invalid baseline ref");
if (!options["dry-run"] && !["subscription", "gateway"].includes(options["approved-route"])) throw new Error("Verify the owner's approved subscription/Gateway route, then pass --approved-route subscription|gateway. No route is inferred from the claude binary.");
if (!options["dry-run"] && options["approved-route"] === "gateway" && !process.env.ANTHROPIC_BASE_URL) throw new Error("Approved Gateway route needs ANTHROPIC_BASE_URL. Reuse the owner's route; do not create another login.");
const hash = value => createHash("sha256").update(value).digest("hex");
const source = execFileSync("git", ["show", `${options["baseline-ref"]}:plugins/pages/server/tools.ts`], { cwd: root, encoding: "utf8" });
const work = mkdtempSync(path.join(os.tmpdir(), "pages-guidance-"));
const bundleDir = mkdtempSync(path.join(root, "node_modules", ".pages-guidance-"));
try {
  // TypeScript 7 exposes parsing through its native snapshot API, not the old compiler API.
  const baselineFile = path.join(work, "baseline.ts");
  const configFile = path.join(work, "tsconfig.json");
  writeFileSync(baselineFile, source);
  writeFileSync(configFile, JSON.stringify({ compilerOptions: { noResolve: true, noLib: true }, files: ["baseline.ts"] }));
  const api = new API({ cwd: work });
  let baseline;
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configFile] });
    const ast = snapshot.getProject(configFile)?.program.getSourceFile(baselineFile);
    if (!ast) throw new Error("Installed TypeScript parser did not return the baseline AST");
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "PAGES_GUIDANCE") {
        if (!node.initializer || !(ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) throw new Error("Unsupported historical PAGES_GUIDANCE initializer: expected a literal, not executable source");
        if (baseline !== undefined) throw new Error("Ambiguous historical PAGES_GUIDANCE declarations");
        baseline = node.initializer.text;
      }
      node.forEachChild(visit);
    }
    visit(ast);
    snapshot.dispose();
  } finally { api.close(); }
  if (baseline === undefined) throw new Error("Historical PAGES_GUIDANCE literal not found");
  const bundle = path.join(bundleDir, "eval.mjs");
  await build({ stdin: { contents: 'export * from "./server/guidance.ts"; export * from "./scripts/eval-guidance-score.ts";', resolveDir: root }, outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external" });
  const module = await import(pathToFileURL(bundle).href);
  const order = ["PAGES_GUIDANCE", "CODE_WORK_INSTRUCTIONS", "EXAMPLES_INSTRUCTIONS", "PUBLISH_INSTRUCTIONS"];
  const sections = Object.fromEntries(order.map(key => [key, module[key]]));
  const prompts = { baseline, new: order.map(key => sections[key]).join("\n\n") };
  const allCases = JSON.parse(readFileSync(path.join(root, "scripts/eval-guidance-cases.json"), "utf8"));
  const cases = options.case ? allCases.filter(test => test.id === options.case) : allCases;
  if (!cases.length) throw new Error(`Unknown case ${options.case}`);
  const out = path.resolve(options.out); mkdirSync(out, { recursive: true });
  let cliVersion = "not invoked (dry-run)";
  // An allowlist prevents accidental paid-key inheritance. HOME preserves existing subscription auth.
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", ...(options["approved-route"] === "gateway" ? ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] : [])].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  if (!options["dry-run"]) {
    const version = spawnSync("claude", ["--version"], { cwd: work, env, encoding: "utf8", timeout: 15000 });
    if (version.error || version.status !== 0) throw new Error("Claude CLI is unavailable. Configure the approved subscription/Gateway route; no provider fallback is allowed.");
    cliVersion = version.stdout.trim();
  }
  const metadata = { kind: options["dry-run"] ? "deterministic dry-run, not model compliance" : "tool-free prompt-response eval", baselineRef: options["baseline-ref"], baselineSourceHash: hash(source), guidanceHash: hash(readFileSync(path.join(root, "server/guidance.ts"))), model: options.model, provider: options.provider, approvedRoute: options["approved-route"] ?? null, cliVersion, order, sections, characterCounts: Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, value.length])), prompts, promptHashes: { baseline: hash(prompts.baseline), new: hash(prompts.new) }, baselineScope: "Old PAGES_GUIDANCE literal only; old tool-call recommendation retained, tools unavailable.", newScope: "Person configure plus three neutral tool references in recorded order; not BB discovery/delivery simulation." };
  writeFileSync(path.join(out, "metadata.json"), JSON.stringify(metadata, null, 2));
  writeFileSync(path.join(work, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  const rows = [];
  for (const variant of options.variant === "both" ? ["baseline", "new"] : [options.variant]) {
    for (const test of cases) for (let repeat = 1; repeat <= repeats; repeat++) {
      const prompt = `${test.request}\n\nSupplied synthetic evidence (paths are illustrative unless declared fixtures):\n${test.evidence}${test.fixtures ? `\nReadable eval fixtures:\n${JSON.stringify(test.fixtures)}` : ""}`;
      const started = Date.now();
      let answer = test.dryReply, raw = answer, status = 0, failure, signal = null;
      if (!options["dry-run"]) {
        const child = spawnSync("claude", ["-p", "--model", options.model, "--append-system-prompt", prompts[variant], "--output-format", "json", "--no-session-persistence", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", path.join(work, "mcp.json")], { input: prompt, cwd: work, env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
        status = child.status; signal = child.signal; raw = child.stdout ?? ""; answer = "";
        if (child.error || status !== 0) failure = child.error?.code === "ETIMEDOUT" ? "Claude timed out" : `Claude failed (${status ?? signal ?? child.error?.code}); verify approved authentication/routing. No fallback attempted.`;
        else try {
          const response = JSON.parse(raw);
          if (response.is_error || typeof response.result !== "string") throw new Error("Missing successful string result");
          answer = response.result;
        } catch (error) { failure = `Invalid CLI output: ${error.message}`; }
      }
      const score = await module.scoreGuidanceReply(test, answer, failure);
      const row = { variant, repeat, model: options.model, durationMs: Date.now() - started, status, signal, prompt, rawAnswer: raw, answer, ...score };
      rows.push(row);
      writeFileSync(path.join(out, "records.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      console.log(`${variant} ${test.id} #${repeat}: ${row.pass ? "pass" : "FAIL"}${failure ? ` (${failure})` : ""}`);
    }
  }
  const summary = module.summarizeGuidanceRun(rows);
  writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); rmSync(bundleDir, { recursive: true, force: true }); }
