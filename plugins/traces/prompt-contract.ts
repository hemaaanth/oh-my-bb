import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const usageSchema = z.object({
  inputTokens: z.number().nullable(), cacheReadTokens: z.number().nullable(), cacheWriteTokens: z.number().nullable(),
  cacheWrite5mTokens: z.number().nullable(), cacheWrite1hTokens: z.number().nullable(),
  outputTokens: z.number().nullable(), reasoningTokens: z.number().nullable(),
}).strict();

export const sectionSchema = z.object({
  id: z.string(), label: z.string(), kind: z.enum(["system", "injected", "developer"]),
  chars: z.number().nullable(), estimatedTokens: z.number().nullable(), text: z.string().nullable(), truncated: z.boolean(),
}).strict();

export const toolSchema = z.object({
  name: z.string(), chars: z.number().nullable(), estimatedTokens: z.number().nullable(),
  description: z.string().nullable(), schema: z.string().nullable(), truncated: z.boolean(),
}).strict();

export const callRowSchema = z.object({
  index: z.number().int(), at: z.number().nullable(), model: z.string().nullable(), requestId: z.string().nullable(),
  turnId: z.string().nullable(), durationMs: z.number().nullable(), usage: usageSchema.nullable(),
}).strict();

export const promptResultSchema = z.object({
  status: z.enum(["available", "unsupported", "unavailable", "truncated"]), reason: z.string().nullable(),
  threadId: z.string(), provider: z.string(), sessionId: z.string().nullable(),
  callCount: z.number().int(), selectedIndex: z.number().int().nullable(),
  selected: callRowSchema.extend({
    system: z.array(sectionSchema), tools: z.array(toolSchema), injected: z.array(sectionSchema),
    params: z.object({ maxTokens: z.number().nullable(), thinking: z.string().nullable(), effort: z.string().nullable() }).strict(),
    contextUsedTokens: z.number().nullable(), contextWindowTokens: z.number().nullable(),
    diff: z.object({ previousCall: z.number().int().nullable(), systemChanged: z.boolean().nullable(),
      modelChanged: z.boolean().nullable(), toolsAdded: z.array(z.string()), toolsRemoved: z.array(z.string()),
      injectedAdded: z.array(z.string()), injectedRemoved: z.array(z.string()) }).strict(),
  }).strict().nullable(),
  ledger: z.array(callRowSchema), ledgerStart: z.number().int(),
  totals: usageSchema.nullable(),
  scan: z.object({ bytesRead: z.number(), linesRead: z.number(), malformedLines: z.number(), oversizedLines: z.number(), limited: z.boolean() }).strict(),
}).strict();
export type PromptResult = z.infer<typeof promptResultSchema>;
export type PromptCall = NonNullable<PromptResult["selected"]>;
export type PromptUsage = z.infer<typeof usageSchema>;
export type PromptSection = z.infer<typeof sectionSchema>;
export type PromptTool = z.infer<typeof toolSchema>;

export const promptHostContract = defineRpcContract({
  promptRead: {
    input: z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/), provider: z.enum(["claude-code", "codex"]),
      sessionId: z.string().uuid(), call: z.number().int().min(1).max(100_000).nullable(), reveal: z.boolean() }).strict(),
    output: promptResultSchema,
    experimental_retryable: true,
  },
});
