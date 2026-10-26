import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const shareModeSchema = z.enum(["view", "review"]);
export const tunnelModeSchema = z.enum(["quick", "custom"]);

export const shareStatusSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    title: z.string(),
    mode: shareModeSchema,
    tunnelMode: tunnelModeSchema,
    publicUrl: z.string(),
    localUrl: z.string(),
    accessCode: z.string(),
    previewUrl: z.string().nullable(),
    ready: z.boolean(),
    startedAt: z.number(),
    expiresAt: z.number().nullable(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  status: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      share: shareStatusSchema.nullable(),
      customHostname: z.string(),
      customConfigured: z.boolean(),
      cloudflaredAvailable: z.boolean(),
      pinpointTargetUrl: z.string().nullable(),
    }),
  },
  reviewTarget: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ url: z.string().nullable() }),
  },
  share: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ share: shareStatusSchema.nullable() }),
  },
  start: {
    input: z
      .object({
        threadId: z.string(),
        durationMinutes: z.number().int().min(0).max(525_600),
        mode: shareModeSchema,
        tunnelMode: tunnelModeSchema,
      })
      .strict(),
    output: z.object({ share: shareStatusSchema }),
  },
  list: {
    input: z.null(),
    output: z.object({ shares: z.array(shareStatusSchema) }),
  },
  revoke: {
    input: z.object({ shareId: z.string() }).strict(),
    output: z.object({ stopped: z.boolean() }),
  },
  stop: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ stopped: z.boolean() }),
  },
});

export type ShareMode = z.infer<typeof shareModeSchema>;
export type TunnelMode = z.infer<typeof tunnelModeSchema>;
export type ShareStatus = z.infer<typeof shareStatusSchema>;
