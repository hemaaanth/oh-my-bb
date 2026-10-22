#!/usr/bin/env node
// Standalone: copied to sandbox hosts. No package dependencies.
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const BEGIN = "# >>> model-gateway (managed by bb gateway setup omp)";
const END = "# <<< model-gateway";
const PROVIDERS = /^providers:[ \t]*(?:#.*)?$/mu;

function ompBlock(baseUrl, indent, models = []) {
  return [BEGIN, `${indent}model-gateway:`, `${indent.repeat(2)}baseUrl: ${baseUrl}`,
    `${indent.repeat(2)}apiKey: MODEL_GATEWAY_TOKEN`, `${indent.repeat(2)}authHeader: true`,
    `${indent.repeat(2)}api: openai-responses`, `${indent.repeat(2)}discovery:`,
    `${indent.repeat(3)}type: openai-models-list`, ...(models.length ? [`${indent.repeat(2)}models: ${JSON.stringify(models)}`] : []), END].join("\n");
}

export function ompSnippet(baseUrl, models = []) {
  return `providers:\n${ompBlock(baseUrl, "  ", models)}\n`;
}

export function upsertOmpProvider(text, baseUrl, models = []) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END, begin);
  if ((begin >= 0) !== (end >= 0) || (begin >= 0 &&
      (text.indexOf(BEGIN, begin + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0)))
    throw new Error("models.yml has malformed model-gateway markers.");
  if (begin >= 0 && end >= 0) {
    const indent = /\n([ \t]+)model-gateway:/u.exec(text.slice(begin))?.[1] ?? "  ";
    return text.slice(0, begin) + ompBlock(baseUrl, indent, models) + text.slice(end + END.length);
  }
  if (/^[ \t]+model-gateway:/mu.test(text))
    throw new Error("models.yml already has an unmanaged model-gateway provider. Remove it, or edit it by hand with bb gateway setup omp --print.");
  const providers = PROVIDERS.exec(text);
  if (providers === null) {
    if (/^providers:/mu.test(text))
      throw new Error("models.yml writes providers: in a form this command cannot edit. Add the block by hand; see bb gateway setup omp --print.");
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";
    return `${text}${separator}${ompSnippet(baseUrl, models)}`;
  }
  const after = providers.index + providers[0].length;
  const child = text.slice(after).split("\n").slice(1)
    .find((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  const indent = /^([ \t]+)/u.exec(child ?? "")?.[1] ?? "  ";
  return `${text.slice(0, after)}\n${ompBlock(baseUrl, indent, models)}${text.slice(after)}`;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function validateSetupPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") ||
      path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Setup paths must be home-relative without traversal.");
  return value;
}

async function safePath(home, relative) {
  validateSetupPath(relative);
  const file = path.join(home, relative);
  let current = home;
  // Include home itself: a symlink would make the destination ambiguous.
  for (const part of ["", ...relative.split("/")]) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Setup refuses symlink: ${relative}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return file;
}

function mergedContent(file, text) {
  if (typeof file.content !== "string" || file.sha256 !== sha256(file.content))
    throw new Error(`Setup content digest mismatch: ${file.path}`);
  if (file.op === "managed-block") {
    if (file.marker !== BEGIN || file.path !== ".omp/agent/models.yml")
      throw new Error("Unsupported managed block.");
    const baseUrl = /^    baseUrl: (.+)$/mu.exec(file.content)?.[1];
    const models = JSON.parse(/^    models: (.+)$/mu.exec(file.content)?.[1] ?? "[]");
    if (!baseUrl || !Array.isArray(models) || ompSnippet(baseUrl, models) !== file.content) throw new Error("Invalid OMP setup block.");
    return upsertOmpProvider(text ?? "", baseUrl, models);
  }
  if (file.op === "managed-file") {
    if (typeof file.marker !== "string" || !file.marker || !file.content.startsWith(file.marker))
      throw new Error(`Missing managed-file marker: ${file.path}`);
    if (text !== null && !text.startsWith(file.marker))
      throw new Error(`File exists and is not managed by the gateway: ${file.path}`);
    return file.content;
  }
  if (file.op === "pi-settings") {
    const existing = text === null ? {} : JSON.parse(text);
    const defaults = JSON.parse(file.content);
    if (!existing || Array.isArray(existing) || typeof existing !== "object") throw new Error("Expected settings object.");
    if (![undefined, "openai-codex", "anthropic", "model-gateway"].includes(existing.defaultProvider)) throw new Error(`Unsupported Pi provider in ${file.path}; select a gateway model explicitly.`);
    return JSON.stringify({ ...existing, defaultProvider: defaults.defaultProvider, defaultModel: existing.defaultModel ?? defaults.defaultModel,
      enabledModels: (existing.enabledModels ?? ["model-gateway/*"]).map(gatewayRole) }, null, 2) + "\n";
  }
  if (file.op === "json-merge") {
    if (typeof file.key !== "string" || !file.key || ["__proto__", "constructor", "prototype"].includes(file.key))
      throw new Error("Invalid JSON provider key.");
    let existing, incoming;
    try {
      existing = text === null ? {} : JSON.parse(text);
      incoming = JSON.parse(file.content);
    } catch { throw new Error(`Invalid JSON setup file: ${file.path}`); }
    if (!existing || Array.isArray(existing) || typeof existing !== "object") throw new Error("Expected JSON object.");
    if (Object.hasOwn(existing, file.key)) {
      if (JSON.stringify(existing[file.key]) !== JSON.stringify(incoming))
        throw new Error(`Unmanaged JSON provider conflict: ${file.path}`);
      return text;
    }
    existing[file.key] = incoming;
    return `${JSON.stringify(existing, null, 2)}\n`;
  }
  throw new Error("Unknown setup operation.");
}

function gatewayRole(value) {
  if (typeof value !== "string") throw new Error("Expected a model name.");
  if (value.startsWith("@") || value.startsWith("model-gateway/")) return value;
  const match = /^(?:openai-codex|anthropic)\/((?:gpt-|claude-)[a-z0-9.*:-]+)$/iu.exec(value);
  if (!match) throw new Error(`Unsupported model override ${value}; select a gateway model explicitly.`);
  return `model-gateway/${match[1]}`;
}

function ompSettings(text) {
  const migrate = (roles) => Object.fromEntries(Object.entries(roles ?? {}).map(([role, model]) => [role,
    gatewayRole(model).replace(/^model-gateway\/(?!gw-)/u, "model-gateway/gw-")]));
  let json;
  try { json = JSON.parse(text ?? "{}"); } catch { /* Existing YAML is edited through OMP's own parser. */ }
  if (json !== undefined) {
    if (!json || Array.isArray(json) || typeof json !== "object") throw new Error("Expected OMP settings object.");
    return JSON.stringify({ ...json, enabledProviders: ["model-gateway"],
      modelRoles: { default: "model-gateway/gw-gpt-6.1-sol", ...migrate(json.modelRoles) },
      task: { ...json.task, agentModelOverrides: migrate(json.task?.agentModelOverrides) } }, null, 2) + "\n";
  }
  const temporary = mkdtempSync(path.join(tmpdir(), "gateway-omp-config-"));
  const agentDir = path.join(temporary, "agent");
  try {
    mkdirSync(agentDir);
    if (text !== null) writeFileSync(path.join(agentDir, "config.yml"), text);
    const run = (...args) => JSON.parse(execFileSync("omp", ["config", ...args, "--json"], {
      cwd: temporary, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "default", PI_PROFILE: "default" }, encoding: "utf8", timeout: 15000,
    }));
    const current = Object.fromEntries(["modelRoles", "task.agentModelOverrides"].map((key) => [key, run("get", key).value]));
    const next = { enabledProviders: ["model-gateway"], modelRoles: { default: "model-gateway/gw-gpt-6.1-sol", ...migrate(current.modelRoles) },
      "task.agentModelOverrides": migrate(current["task.agentModelOverrides"]) };
    for (const [key, value] of Object.entries(next)) run("set", key, JSON.stringify(value));
    return readFileSync(path.join(agentDir, "config.yml"), "utf8");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

async function reconcile(home, files, check) {
  if (!path.isAbsolute(home) || !Array.isArray(files)) throw new Error("Expected absolute home and files array.");
  const seen = new Set();
  const plans = [];
  // Validate every file before the first write, including conflicts.
  for (const entry of files) {
    if (!entry || seen.has(entry.path)) throw new Error("Duplicate or invalid setup file.");
    seen.add(entry.path);
    const file = await safePath(home, entry.path);
    let text = null;
    try { text = await fs.readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let next;
    if (entry.op === "omp-settings") {
      if (entry.path !== ".omp/agent/config.yml" || entry.sha256 !== sha256(entry.content)) throw new Error("Invalid OMP settings manifest.");
      next = ompSettings(text);
    } else next = mergedContent(entry, text);
    plans.push({ entry, file, text, next });
  }
  const results = [];
  for (const { entry, file, text, next } of plans) {
    const status = text === next ? "current" : text === null ? "missing" : "stale";
    let backup = null;
    const changed = !check && status !== "current";
    if (changed) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (text !== null) {
        backup = `${file}.bak-${Date.now()}`;
        await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
      }
      const temporary = `${file}.tmp-${process.pid}-${results.length}`;
      try {
        await fs.writeFile(temporary, next, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    results.push({ path: entry.path, status, changed, backup });
  }
  return { files: results };
}

export const applySetupFiles = (home, files) => reconcile(home, files, false);
export const checkSetupFiles = (home, files) => reconcile(home, files, true);

// No top-level await: BB bundles this file into the plugin server as CommonJS.
async function main() {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) stdin += chunk;
    const input = JSON.parse(stdin);
    const result = await reconcile(input.home ?? homedir(), input.files, input.check === true);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`model-gateway setup: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
