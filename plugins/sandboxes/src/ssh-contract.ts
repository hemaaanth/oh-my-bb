import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const sandboxSshIdentitySchema = z.object({
  nodeId: z.string().min(1),
  authority: z.string().regex(/^[a-z_][a-z0-9_-]*\$?@[a-z0-9.-]+$/),
  error: z.string().nullable(),
});

export const sandboxSshHostContract = defineRpcContract({
  configureSsh: {
    input: z.object({
      hostId: z.string().regex(/^host_[a-z0-9_]+$/),
      authKey: z.string().min(1),
    }).strict(),
    output: sandboxSshIdentitySchema,
  },
  stopSsh: { input: z.null(), output: z.null() },
  configureBrowserNetwork:{input:z.object({hostId:z.string().regex(/^host_[a-z0-9_]+$/),threadId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),authKey:z.string(),exitNode:z.string().min(1)}).strict(),output:z.object({socket:z.string().min(1),proxyPort:z.number().int().min(1024).max(65535),client:z.string().min(1)})},
  releaseBrowserNetwork:{input:z.object({threadId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable()}).strict(),output:z.null()},
});
