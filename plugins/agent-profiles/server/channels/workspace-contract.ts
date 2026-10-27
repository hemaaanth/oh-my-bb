import { z } from "zod";
import { defaultLimits } from "./usage-defaults";

export const contextContent = z.object({
  brief: z.string().max(16_000).default(""),
  decisions: z.string().max(16_000).default(""),
  memory: z.string().max(16_000).default(""),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});

export const channelContext = contextContent.extend({
  version: z.number().int(),
  updatedAt: z.number(),
});
export type ChannelContext = z.infer<typeof channelContext>;

export const revisionSchema = z.object({
  id: z.number(),
  text: z.string(),
  createdAt: z.number(),
  actor: z.string(),
});

export const usageLimits = z.object({
  turnsPerHour: z.number().int().min(1).max(1_000).default(defaultLimits.turnsPerHour),
  turnsPerDay: z.number().int().min(1).max(10_000).default(defaultLimits.turnsPerDay),
  minutesPerTurn: z.number().int().min(1).max(180).default(defaultLimits.minutesPerTurn),
  concurrentForks: z.number().int().min(1).max(16).default(defaultLimits.concurrentForks),
});
export type UsageLimits = z.infer<typeof usageLimits>;
export { defaultLimits };

export const usageSummary = z.object({
  turns: z.number(),
  forks: z.number(),
  active: z.number(),
  errors: z.number(),
  routingCalls: z.number(),
  routingMilliseconds: z.number(),
  since: z.number(),
  limits: usageLimits,
});
