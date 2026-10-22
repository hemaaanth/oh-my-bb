import { z } from "zod";
import type { ServerContext } from "../context.js";
import type { PodcastProfile } from "../../shared/podcast.js";
import { buildCatalog, toFunctionTools } from "../tools/catalog.js";
import { startThread } from "../tools/start.js";
import { readThread, sendToThread, stopThread, renameThread, setThreadModel, type ToolArgs } from "../tools/threads.js";
import { threadTitle } from "../tools/live.js";

export const CONTROLS = new Set(["start_thread", "send_to_thread", "stop_thread", "rename_thread", "set_thread_model", "answer_question"]);
const ALLOWED = new Set([...CONTROLS, "read_thread"]);
export type PendingAction = { name: string; args: ToolArgs };
export const contextFor = (projectId: string) => ({ projectId, threadId: null, onNewThreadScreen: false, mobile: false, canNavigate: false, channel: "app" as const, focus: false });
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: "string" };
const custom = (name: string, description: string, properties: Record<string, unknown>) => ({ type: "function" as const, name, description, parameters: object(properties) });
export function projectTools() {
  return [
    ...toFunctionTools(buildCatalog({ mobile: false, canNavigate: false, channel: "app", allowedPluginIds: [], callMemory: false }).filter(t => ALLOWED.has(t.name))),
    custom("project_brief", "Get a fast overview of this project: recent visible threads, current outputs, and optional Journal history. Start here for project-wide status questions.", {}),
    custom("project_threads", "List this project's threads. query filters titles. Use an empty query to list recent work. Page with offset. Never invent thread IDs.", { query: str, archived: { type: "boolean" }, offset: { type: "integer", minimum: 0, maximum: 10000 } }),
    custom("project_journal", "Read stored work history for a known thread in this project. Journal may be absent or stale; verify current results with read_thread. No generation.", { thread_id: str, offset: { type: "integer", minimum: 0, maximum: 10000 } }),
    custom("thread_history", "Read a page of the actual user/assistant conversation. Use empty before_id and before_seq for latest; use returned cursor for older pages.", { thread_id: str, before_id: str, before_seq: str }),
    custom("answer_question", "Answer a pending user question using the user's spoken answer. Read thread_questions first. answers_json maps question IDs to {selected: [option values], freeText?: string}. Cannot approve tools or permissions.", { thread_id: str, interaction_id: str, answers_json: str }),
    custom("thread_questions", "Read pending questions/approvals on a thread in this project. Never resolve an approval as a normal message.", { thread_id: str }),
  ];
}

export async function ownThread(ctx: ServerContext, projectId: string, threadId: string) {
  const thread = await ctx.bb.sdk.threads.get({ threadId });
  if (thread.projectId !== projectId || thread.visibility === "hidden") throw new Error("That thread is not available in this project.");
  return thread;
}

// Read each source separately: Journal's grouped root rows may include another project's children.
export async function journalThread(ctx: ServerContext, projectId: string, threadId: string, offset = 0, signal?: AbortSignal) {
  await ownThread(ctx, projectId, threadId);
  const result = await ctx.bb.sdk.plugins.callRpc({ pluginId: "journal", method: "read.show", input: { threadId, limit: 10, offset }, outputSchema: z.object({
    thread: z.object({ threadId: z.string(), projectId: z.string(), summary: z.string(), outcome: z.string().nullable() }),
    days: z.array(z.object({ dayStart: z.number(), summary: z.string(), outcome: z.string().nullable(), workStatus: z.string().nullable() })),
    hasMore: z.boolean(),
  }), signal });
  if (result.thread.projectId !== projectId || result.thread.threadId !== threadId) throw new Error("Journal ownership does not match this project.");
  await ownThread(ctx, projectId, threadId);
  return result;
}

export async function scopedTool(ctx: ServerContext, profile: PodcastProfile, name: string, args: ToolArgs, options: { signal: AbortSignal; propose: (action: PendingAction) => void; readOnly?: boolean }) {
  options.signal.throwIfAborted();
  if (args.project_id !== undefined && args.project_id !== profile.projectId) throw new Error("A project speaker cannot change project scope.");
  if (options.readOnly && CONTROLS.has(name)) throw new Error("An update cannot take actions without a user request.");
  const threadId = typeof args.thread_id === "string" ? args.thread_id : "";
  if (name !== "start_thread" && name !== "project_threads" && name !== "project_brief") await ownThread(ctx, profile.projectId, threadId);
  options.signal.throwIfAborted();
  const context = contextFor(profile.projectId);
  switch (name) {
    case "project_brief": {
      const rows = await ctx.bb.sdk.threads.list({ projectId: profile.projectId, archived: false, limit: 12 });
      const threads = rows.filter(row => row.projectId === profile.projectId && row.visibility !== "hidden");
      const details = await Promise.all(threads.slice(0, 6).map(async row => {
        try {
          await ownThread(ctx, profile.projectId, row.id);
          const [{ output }, journal] = await Promise.all([
            ctx.bb.sdk.threads.output({ threadId: row.id, signal: options.signal }),
            journalThread(ctx, profile.projectId, row.id, 0, options.signal).catch(() => null),
          ]);
          await ownThread(ctx, profile.projectId, row.id);
          return { id: row.id, title: threadTitle(row), status: row.runtime.displayStatus, currentOutput: output?.slice(0, 1200) ?? null,
            history: journal ? { summary: journal.thread.summary.slice(0, 600), outcome: journal.thread.outcome?.slice(0, 600), days: journal.days.slice(0, 2) } : null };
        } catch { return null; }
      }));
      return { threads: threads.map(row => ({ id: row.id, title: threadTitle(row), status: row.runtime.displayStatus })), details: details.filter(Boolean), note: "Recent work only. Page project_threads or read source history for older or more work. Journal may be stale or unavailable." };
    }
    case "project_threads": {
      const offset = typeof args.offset === "number" ? Math.max(0, Math.min(10000, args.offset)) : 0;
      const threads = await ctx.bb.sdk.threads.list({ projectId: profile.projectId, archived: args.archived === true, offset, limit: 50 });
      const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
      return { threads: threads.filter(t => t.projectId === profile.projectId && t.visibility !== "hidden" && threadTitle(t).toLowerCase().includes(query)).map(t => ({ id: t.id, title: threadTitle(t), status: t.runtime.displayStatus, updatedAt: t.updatedAt })), nextOffset: threads.length === 50 ? offset + 50 : null };
    }
    case "project_journal": return journalThread(ctx, profile.projectId, threadId, typeof args.offset === "number" ? args.offset : 0, options.signal);
    case "thread_history": {
      const page = await ctx.bb.sdk.threads.timeline({ threadId, includeNestedRows: "false", segmentLimit: "30", summaryOnly: "false", ...(args.before_id && args.before_seq ? { beforeAnchorId: String(args.before_id), beforeAnchorSeq: String(args.before_seq) } : {}), signal: options.signal });
      await ownThread(ctx, profile.projectId, threadId);
      // Only direct conversation rows; never traverse nested thread previews or tool payloads.
      const messages = page.rows.flatMap(row => {
        const item = row as unknown as Record<string, unknown>;
        return item.kind === "conversation" && (item.role === "user" || item.role === "assistant") && typeof item.text === "string" ? [{ role: item.role, text: item.text.slice(0, 4000) }] : [];
      });
      return { messages, page: page.timelinePage };
    }
    case "thread_questions": return ctx.bb.sdk.threads.interactions.list({ threadId });
    case "answer_question": {
      const interactionId = z.string().min(1).parse(args.interaction_id);
      const interaction = await ctx.bb.sdk.threads.interactions.get({ threadId, interactionId, signal: options.signal });
      if (interaction.threadId !== threadId || interaction.status !== "pending" || interaction.payload.kind !== "user_question") throw new Error("This is not a pending user question. Approvals need the normal BB approval controls.");
      const answers = z.record(z.string(), z.object({ selected: z.array(z.string()).max(20), freeText: z.string().max(8000).optional() }).strict()).parse(JSON.parse(String(args.answers_json)));
      const questions = interaction.payload.questions;
      if (Object.keys(answers).some(id => !questions.some(q => q.id === id)) || questions.some(q => !answers[q.id])) throw new Error("Answer the pending question IDs exactly.");
      for (const question of questions) {
        const answer = answers[question.id]!;
        if ((!question.multiSelect && answer.selected.length > 1) || (answer.freeText && !question.allowFreeText) || answer.selected.some(value => !question.options?.some(option => option.value === value))) throw new Error("That answer does not match the question's allowed choices.");
      }
      await ownThread(ctx, profile.projectId, threadId); options.signal.throwIfAborted();
      return ctx.bb.sdk.threads.interactions.resolve({ threadId, interactionId, resolution: { kind: "user_answer", answers } });
    }
    case "read_thread": {
      const result = await readThread(ctx, args);
      await ownThread(ctx, profile.projectId, threadId);
      return result;
    }
    case "start_thread": {
      if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("Give an instruction to start a thread by voice.");
      return startThread(ctx, { ...args, project_id: profile.projectId }, context);
    }
    case "send_to_thread": return sendToThread(ctx, args, context);
    case "rename_thread": return renameThread(ctx, args);
    case "stop_thread":
    case "set_thread_model":
      options.propose({ name, args });
      return { confirmationRequired: true, instruction: "Ask the user to confirm this action. It has NOT run. Only a later spoken confirmation runs it." };
    default: throw new Error("This tool is not available to project speakers.");
  }
}
export async function confirmAction(ctx: ServerContext, profile: PodcastProfile, action: PendingAction, signal: AbortSignal) {
  await ownThread(ctx, profile.projectId, String(action.args.thread_id));
  signal.throwIfAborted();
  return action.name === "stop_thread" ? stopThread(ctx, action.args) : setThreadModel(ctx, action.args);
}
