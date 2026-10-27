import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
 createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
 getAgentDir, parseFrontmatter, withFileMutationQueue,
 type AgentSession, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { READ_TOOLS, mergeConfig, validName, resolveSelection, type AgentDefinition, type Config, type Selection } from "./config.ts";
import { addUsage, emptyUsage, isRetryable, Requests, visibleText } from "./requests.ts";

const promptsDir = fileURLToPath(new URL("../prompts/", import.meta.url));
export async function promptFile(name: string): Promise<string> {
 if (!validName(name)) throw new Error("Invalid bundled prompt name");
 return fs.readFile(path.join(promptsDir, `${name}.md`), "utf8");
}
export async function agentInstructions(definition: AgentDefinition): Promise<string> {
 return ["scout", "planner", "reviewer", "worker"].includes(definition.instructions) ? promptFile(definition.instructions) : definition.instructions;
}
/** Native Pi frontmatter parsing, with project files gated by the primary's trust decision. */
export async function discoverAgentFiles(base: Config, directory: string, warn: (message: string) => void): Promise<Config> {
 let files: string[];
 try { files = (await fs.readdir(directory)).filter((name) => name.endsWith(".md")).sort(); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return base; throw error; }
 let config = base;
 for (const filename of files) {
  try {
   const file = path.join(directory, filename);
   if ((await fs.stat(file)).size > 256 * 1024) throw new Error("agent definition exceeds 256 KiB");
   const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(await fs.readFile(file, "utf8"));
   const name = frontmatter.name;
   if (typeof name !== "string" || !validName(name)) throw new Error("valid name required");
   const allowed = ["name", "description", "tools", "role", "model", "thinking", "thinking-level", "maxRequests"];
   for (const key of Object.keys(frontmatter)) if (!allowed.includes(key)) throw new Error(`unsupported field ${key}`);
   const model = frontmatter.model;
   const modelRole = `agent-${name}`;
   const role = typeof model === "string" ? modelRole : frontmatter.role ?? (config.agents[name]?.role ?? "task");
   config = mergeConfig(config, {
    ...(typeof model === "string" ? { roles: { [modelRole]: { model, ...(frontmatter.thinking ?? frontmatter["thinking-level"] ? { thinkingLevel: frontmatter.thinking ?? frontmatter["thinking-level"] } : {}) } } } : {}),
    agents: { [name]: {
     description: frontmatter.description, role, instructions: body,
     ...(frontmatter.tools !== undefined ? { tools: typeof frontmatter.tools === "string" ? frontmatter.tools.split(",").map((v) => v.trim()).filter(Boolean) : frontmatter.tools } : {}),
     ...(frontmatter.maxRequests !== undefined ? { maxRequests: frontmatter.maxRequests } : {}),
    } },
   }, file);
  } catch (error) { warn(`${filename}: ${error instanceof Error ? error.message : String(error)}`); }
 }
 return config;
}
export function childUsage(manager: SessionManager): Usage {
 const total = emptyUsage();
 for (const entry of manager.getEntries()) {
  if (entry.type === "message" && entry.message.role === "assistant") addUsage(total, entry.message.usage);
  else if ((entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) addUsage(total, entry.usage);
 }
 return total;
}
export async function artifactDirectory(ctx: ExtensionContext, kind: string): Promise<string | undefined> {
 const parent = ctx.sessionManager.getSessionFile();
 if (!parent) return;
 const directory = path.join(path.dirname(parent), `${path.basename(parent, ".jsonl")}.hempi`, kind);
 await fs.mkdir(directory, { recursive: true, mode: 0o700 });
 return directory;
}
export interface Child {
 session: AgentSession;
 manager: SessionManager;
 selection: Selection;
 resetBudget(): void;
 stop(): Promise<void>;
}
export interface ChildOptions {
 ctx: ExtensionContext; requests: Requests; config: Config; selection: Selection;
 kind: string; instructions: string; tools: string[]; maxRequests: number;
 customTools?: ToolDefinition[];
 extensions?: (pi: ExtensionAPI) => void;
 workspaceOnly?: boolean;
 beforeRequest?: (model: Model<Api>, contextBytes: number, maxTokens: number) => void;
}
/** An isolated native SDK session. Its provider adapter delegates credentials to the public parent broker. */
export async function createChild(options: ChildOptions): Promise<Child> {
 const { ctx, requests, selection, kind } = options;
 const candidates = requests.candidates(selection, ctx);
 const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
 let requestCount = 0;
 let stopped = false;
 const modelsByProvider = new Map<string, Model<Api>[]>();
 for (const candidate of candidates) {
  const list = modelsByProvider.get(candidate.modelObject.provider) ?? [];
  list.push(candidate.modelObject); modelsByProvider.set(candidate.modelObject.provider, list);
 }
 for (const [provider, models] of modelsByProvider) {
  runtime.registerProvider(provider, {
   apiKey: "hempi-delegated-auth-never-sent", authHeader: false,
   baseUrl: models[0].baseUrl, api: models[0].api,
   models: models.map((model) => ({ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevelMap: model.thinkingLevelMap, compat: model.compat })),
   streamSimple: (model, context, streamOptions) => {
    const physical = candidates.find((candidate) => candidate.modelObject.provider === model.provider && candidate.modelObject.id === model.id) ?? selection;
    const policy = kind === "advisor" ? { ...physical, tier: selection.tier } : physical;
    return requests.stream(policy, context, kind, streamOptions?.sessionId ?? randomUUID(), ctx, {
     ...streamOptions,
     onPayload: async (payload, requestModel) => {
      if (stopped) throw new Error("Agent stopped");
      if (++requestCount > options.maxRequests) throw new Error(`Agent request budget exhausted (${options.maxRequests})`);
      options.beforeRequest?.(requestModel, Buffer.byteLength(JSON.stringify(context), "utf8"), policy.maxTokens ?? 8192);
      return streamOptions?.onPayload?.(payload, requestModel);
     },
    });
   },
  });
 }
 await runtime.refresh({ allowNetwork: false, providers: [...modelsByProvider.keys()] });
 const directory = await artifactDirectory(ctx, kind.replace(/[^a-zA-Z0-9_-]/g, "-"));
 const manager = directory ? SessionManager.create(ctx.cwd, directory) : SessionManager.inMemory(ctx.cwd);
 const reserved = Math.min(8192, Math.max(1024, Math.floor(selection.modelObject.contextWindow * 0.1)));
 const settings = SettingsManager.inMemory({
  cacheWarming: "off", transport: "sse", enableInstallTelemetry: false,
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
  compaction: { enabled: true, reserveTokens: reserved, keepRecentTokens: Math.min(12000, Math.max(1024, Math.floor(selection.modelObject.contextWindow * 0.2))) },
 });
 const root = await fs.realpath(ctx.cwd);
 const loader = new DefaultResourceLoader({
  cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  systemPromptOverride: () => options.instructions,
  appendSystemPromptOverride: () => [],
  extensionFactories: [(pi) => {
   pi.on("tool_call", async (event) => {
    if (stopped) return { block: true, reason: "Agent stopped" };
    if (!options.tools.includes(event.toolName) && !options.customTools?.some((tool) => tool.name === event.toolName)) return { block: true, reason: "Tool is not granted to this agent" };
    if (options.workspaceOnly && READ_TOOLS.includes(event.toolName)) {
     const rawPath = "path" in event.input ? event.input.path : undefined;
     const target = path.resolve(root, typeof rawPath === "string" ? rawPath : ".");
     let real = target;
     try { real = await fs.realpath(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
     if (real !== root && !real.startsWith(root + path.sep)) return { block: true, reason: "Advisor tools are confined to the workspace" };
    }
   });
   options.extensions?.(pi);
  }],
 });
 await loader.reload();
 const { session } = await createAgentSession({
  cwd: ctx.cwd, agentDir: getAgentDir(), modelRuntime: runtime,
  model: selection.modelObject, thinkingLevel: selection.thinkingLevel,
  resourceLoader: loader, sessionManager: manager, settingsManager: settings,
  tools: [...options.tools, ...(options.customTools ?? []).map((tool) => tool.name)], customTools: options.customTools,
 });
 await session.bindExtensions({ mode: "json" });
 return {
  session, manager, selection,
  resetBudget() { requestCount = 0; },
  async stop() { if (stopped) return; stopped = true; try { await session.abort(); } finally { session.dispose(); } },
 };
}
export interface AgentResult { agent: string; answer: string; file?: string; usage: Usage; model: string; error?: string }
export class Agents {
 readonly #pi: ExtensionAPI;
 readonly #requests: Requests;
 readonly #config: () => Config;
 readonly #children = new Set<Child>();
 #generation = 0;
 constructor(pi: ExtensionAPI, requests: Requests, config: () => Config) { this.#pi = pi; this.#requests = requests; this.#config = config; }
 async stop(): Promise<void> { this.#generation++; await Promise.all([...this.#children].map((child) => child.stop())); this.#children.clear(); }
 async run(name: string, task: string, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<AgentResult> {
  const config = this.#config();
  if (!Object.hasOwn(config.agents, name)) throw new Error(`Unknown agent ${name}`);
  const definition = config.agents[name];
  const generation = this.#generation;
  const execute = async (): Promise<AgentResult> => {
   signal?.throwIfAborted();
   const selection = resolveSelection(config, definition.role, ctx);
   const child = await createChild({ ctx, requests: this.#requests, config, selection, kind: `agent-${name}`, tools: definition.tools, maxRequests: definition.maxRequests, instructions: `${await agentInstructions(definition)}\n\n<primary-constraints>\n${ctx.getSystemPrompt()}\n</primary-constraints>` });
   this.#children.add(child);
   const abort = () => { void child.session.abort(); };
   signal?.addEventListener("abort", abort, { once: true });
   if (generation !== this.#generation || signal?.aborted) await child.stop();
   const unsubscribe = child.session.subscribe((event) => {
    if (event.type === "tool_execution_start") onUpdate?.(`${name}: ${event.toolName}`);
    else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") onUpdate?.(event.assistantMessageEvent.delta);
   });
   try {
    const candidates = this.#requests.candidates(selection, ctx);
    let lastError: string | undefined;
    child.resetBudget();
    for (const candidate of candidates) {
     signal?.throwIfAborted();
     if (generation !== this.#generation) throw new Error("Session changed while starting agent");
     await child.session.setModel(candidate.modelObject);
     child.session.setThinkingLevel(candidate.thinkingLevel);
     await child.session.prompt(task);
     const tail = child.session.messages.findLast((message) => message.role === "assistant");
     if (tail?.role !== "assistant") { lastError = "Agent returned no answer"; break; }
     if (tail.stopReason === "error" || tail.stopReason === "aborted") {
      lastError = tail.errorMessage ?? tail.stopReason;
      if (tail.stopReason === "aborted" || (!isRetryable(lastError) && !/quota|usage limit|credits/i.test(lastError))) break;
      continue;
     }
     const usage = childUsage(child.manager);
     const result: AgentResult = { agent: name, answer: visibleText(tail), file: child.manager.getSessionFile(), usage, model: `${tail.provider}/${tail.model}` };
     if (generation === this.#generation) this.#pi.appendEntry("hempi.agent", result);
     return result;
    }
    const result: AgentResult = { agent: name, answer: "", file: child.manager.getSessionFile(), usage: childUsage(child.manager), model: `${selection.modelObject.provider}/${selection.modelObject.id}`, error: lastError ?? "No agent model available" };
    if (generation === this.#generation) this.#pi.appendEntry("hempi.agent", result);
    return result;
   } finally { unsubscribe(); signal?.removeEventListener("abort", abort); await child.stop(); this.#children.delete(child); }
  };
  // Read-only agents run concurrently. Entire writer tasks share Pi's mutation queue to avoid stale overwrites.
  return definition.tools.some((tool) => !READ_TOOLS.includes(tool)) ? withFileMutationQueue(path.join(ctx.cwd, ".hempi-worker-lease"), execute) : execute();
 }
 register(): void {
  const agents = this;
  this.#pi.registerTool({
   name: "delegate", label: "Delegate",
   description: "Run named specialized agents with isolated conversations and explicitly granted tools. Use /agents to inspect configured agents. Read-only agents can run in parallel; writer tasks are serialized in the shared workspace. Each result includes its transcript path and actual usage.",
   exposure: "model-only",
   parameters: Type.Object({
    tasks: Type.Array(Type.Object({ agent: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1, maxLength: 128000 }) }), { minItems: 1, maxItems: 8 }),
    mode: Type.Optional(Type.Union([Type.Literal("parallel"), Type.Literal("chain")])),
   }),
   promptGuidelines: ["Delegate concrete independent subtasks, not responsibility for understanding the user's goal. Provide goal, relevant context, scope, and success criteria. Use scout/planner/reviewer for read-only work, and explicitly select worker for edits."],
   execute: async (_id, params, signal, onUpdate, ctx) => {
    const primaryCanWrite = agents.#pi.getActiveTools().some((tool) => ["bash", "powershell", "edit", "write"].includes(tool));
    for (const task of params.tasks) {
     const definition = agents.#config().agents[task.agent];
     if (!definition) throw new Error(`Unknown agent ${task.agent}`);
     if (!primaryCanWrite && definition.tools.some((tool) => !READ_TOOLS.includes(tool))) throw new Error("The primary read-only loadout cannot delegate to a writer");
    }
    const results: AgentResult[] = new Array(params.tasks.length);
    const progress = (text: string) => onUpdate?.({ content: [{ type: "text", text: text.slice(-4000) }], details: { results: results.filter(Boolean) } });
    let cursor = 0;
    const next = async () => {
     while (cursor < params.tasks.length) {
      const index = cursor++;
      const task = params.tasks[index];
      signal?.throwIfAborted();
      const previous = params.mode === "chain" && index > 0 ? results[index - 1].answer : "";
      try { results[index] = await agents.run(task.agent, params.mode === "chain" ? task.task.replaceAll("{previous}", previous) : task.task, ctx, signal, progress); }
      catch (error) { results[index] = { agent: task.agent, answer: "", model: "", usage: emptyUsage(), error: error instanceof Error ? error.message : String(error) }; }
      if (params.mode === "chain" && results[index].error) break;
     }
    };
    await Promise.all(Array.from({ length: params.mode === "chain" ? 1 : Math.min(4, params.tasks.length) }, next));
    const finished = results.filter(Boolean);
    const usage = emptyUsage(); for (const result of finished) addUsage(usage, result.usage);
    return {
     content: finished.map((result) => ({ type: "text" as const, text: `${result.agent}${result.error ? ` ERROR: ${result.error}` : ""}\n${result.answer.slice(0, 50000)}${result.answer.length > 50000 ? "\n[Output truncated; see the transcript file.]" : ""}${result.file ? `\nTranscript: ${result.file}` : ""}` })),
     details: { results: finished }, usage, isError: finished.some((result) => !!result.error),
    };
   },
  });
 }
}
