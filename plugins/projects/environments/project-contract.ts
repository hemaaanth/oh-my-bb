import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const projectEnvironmentContract = defineRpcContract({
  setProjectEnvironmentToken: {
    input: z.object({ projectId: z.string().min(1), expectedProfileId: z.string().min(1), expectedUpdatedAt: z.string(), token: z.string().min(1), confirmShared: z.boolean().default(false) }).strict(),
    output: z.object({ configured: z.literal(true) }).strict(),
  },
  saveProjectEnvironment: {
    input: z.object({ projectId: z.string().min(1), expectedProfileId: z.string().nullable(), expectedUpdatedAt: z.string().nullable(), name: z.string().trim().min(1).max(200), environmentName: z.string().max(500), environmentId: z.string().max(500), account: z.string().max(500), serviceAccountName: z.string().max(500), confirmShared: z.boolean().default(false) }).strict(),
    output: z.object({ id: z.string(), updatedAt: z.string() }).strict(),
  },
});
