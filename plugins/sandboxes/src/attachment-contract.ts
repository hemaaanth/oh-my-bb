import { z } from "zod";

export const attachmentChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("auth"),
      ids: z.array(z.enum(["github", "subscription"])).max(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal("credentials"),
      id: z.string().uuid().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tools"),
      ids: z.array(z.string().min(1)).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("skills"),
      ids: z.array(z.string().min(1)).max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agents"),
      ids: z.array(z.string().uuid()).max(100),
    })
    .strict(),
]);
export type AttachmentChange = z.infer<typeof attachmentChangeSchema>;
export const attachmentOperationSchema = z.object({
  state: z.enum(["applying", "failed"]),
  change: attachmentChangeSchema,
  error: z.string().nullable(),
});
const optionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  sourceId: z.string().optional(),
  sourceName: z.string().optional(),
});
export const attachmentsViewSchema = z.object({
  sandboxId: z.string(),
  credentialProfileId: z.string().nullable(),
  authIds: z.array(z.string()).nullable(),
  toolIds: z.array(z.string()),
  skillIds: z.array(z.string()),
  agentIds: z.array(z.string()),
  credentials: z.array(optionSchema),
  tools: z.array(optionSchema),
  skills: z.array(optionSchema),
  agents: z.array(optionSchema),
  operation: attachmentOperationSchema.nullable(),
});
export type AttachmentsView = z.infer<typeof attachmentsViewSchema>;
