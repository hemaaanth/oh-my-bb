import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const platformSchema = z.enum(["ios", "android"]);
export type Platform = z.infer<typeof platformSchema>;
export const THREAD_CHANGED = "revyl-show";
const threadId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const embedUrl = z.string().url().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.origin === "https://app.revyl.ai" && /^\/embed\/[A-Za-z0-9_-]+$/.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}, "Use the plain Revyl public embed URL, without parameters");
const deviceInput = z.object({ threadId, platform: platformSchema });
export const rpcContract = defineRpcContract({
  revyl_embed: { input: deviceInput, output: z.string().url().nullable() },
  revyl_configure: { input: deviceInput.extend({ url: embedUrl }), output: z.boolean() },
});
