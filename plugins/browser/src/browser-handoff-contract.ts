import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const browserHandoffHostContract = defineRpcContract({
  browserThreadControl: {
    input: z.object({ threadId, action: z.enum(["pause", "resume", "show", "close", "discard"]) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});
export const browserLiveState=z.object({kind:z.enum(["closed","local","watch","handoff"]),url:z.string().optional()});
export type BrowserLiveState=z.infer<typeof browserLiveState>;
export const browserHandoffRpcContract = defineRpcContract({
  openBrowserView:{input:z.object({threadId}).strict(),output:browserLiveState},
  getBrowserView:{input:z.object({threadId}).strict(),output:browserLiveState},
  closeBrowserView:{input:z.object({threadId}).strict(),output:z.null()},
  showBrowserHandoff: { input: z.object({ threadId }).strict(), output: z.object({ ok: z.boolean() }) },
});
export const BROWSER_HANDOFF_RENDERER = "browser-handoff";
