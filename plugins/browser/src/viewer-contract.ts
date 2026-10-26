import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const viewerAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame") }).strict(),
  z.object({ type: z.literal("pointer"), event: z.enum(["down", "up", "move"]), x: z.number().min(0).max(16384), y: z.number().min(0).max(16384) }).strict(),
  z.object({ type: z.literal("tab"), target: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict(),
  z.object({ type: z.literal("scroll"), deltaY: z.number().min(-1000).max(1000) }).strict(),
  z.object({ type: z.literal("dialog"), accept: z.boolean(), promptText: z.string().max(4096).optional() }).strict(),
  z.object({ type: z.literal("text"), text: z.string().max(4096) }).strict(),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(40),modifiers:z.array(z.enum(['Control','Alt','Shift','Meta'])).max(4).optional() }).strict(),
]);
const desktopOwner=z.object({pid:z.number().int().min(2),start:z.string().regex(/^\d+$/)}).strict();
export const browserDesktopTarget=z.object({display:z.string().regex(/^:\d+$/),authority:z.string().min(1).max(4096),vncSocket:z.string().regex(/^\/tmp\/bb-vnc-[a-f0-9]{32}\.sock$/).optional(),owner:desktopOwner,displayOwner:desktopOwner}).strict();
export const browserViewerHostContract = defineRpcContract({
  browserDesktopTarget:{input:z.object({threadId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),watch:z.boolean().optional()}).strict(),output:browserDesktopTarget.nullable()},
  browserViewerControl: { input: z.object({ threadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), action: viewerAction }).strict(), output: z.object({ ok: z.boolean(), data: z.string().max(8 * 1024 * 1024) }) },
});
