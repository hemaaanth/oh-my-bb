import type { ServerContext } from "../context.js";
import { openaiKey } from "../live-session.js";
import { responseText } from "../memory.js";

export async function api(ctx: ServerContext, path: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(`https://api.openai.com/v1/${path}`, { method: "POST", headers: { Authorization: `Bearer ${await openaiKey(ctx)}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(`The voice service could not complete the request (${response.status}).`);
  return response;
}
export type ModelItem = Record<string, unknown>;
export type ModelReply = { output: ModelItem[]; usage?: unknown; text: string };
export async function reason(ctx: ServerContext, input: { model: string; instructions: string; input: ModelItem[]; tools?: unknown[]; schema?: Record<string, unknown> }, signal: AbortSignal): Promise<ModelReply> {
  const response = await api(ctx, "responses", {
    model: input.model, instructions: input.instructions, input: input.input,
    ...(input.tools ? { tools: input.tools, parallel_tool_calls: false } : {}),
    ...(input.schema ? { text: { format: { type: "json_schema", name: "project_route", strict: true, schema: input.schema } } } : {}),
    max_output_tokens: input.schema ? 8000 : 2500, store: false, include: ["reasoning.encrypted_content"],
  }, signal);
  const body: unknown = await response.json();
  const result = body as { output?: ModelItem[]; usage?: unknown; status?: string };
  if (!Array.isArray(result.output) || result.status === "incomplete") throw new Error("The reasoning model did not finish its answer. Try a shorter request.");
  return { output: result.output, usage: result.usage, text: responseText(body) };
}
