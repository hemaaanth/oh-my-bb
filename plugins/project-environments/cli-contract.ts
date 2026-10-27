import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const environmentCliContract = defineRpcContract({
  environment_cli: { input: z.object({ argv: z.array(z.string()).max(200), cwd: z.string().optional(), threadId: z.string().optional(), projectId: z.string().optional() }).strict(), output: z.object({ exitCode: z.number().int(), stdout: z.string().optional(), stderr: z.string().optional() }) },
});
