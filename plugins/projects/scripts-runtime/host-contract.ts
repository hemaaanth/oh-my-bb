import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { setupRecipeSchema } from "./setup-contract.js";

export const hostContract = defineRpcContract({
  stage_setup: {
    input: z.object({ cwd: z.string().min(1), recipe: setupRecipeSchema }).strict(),
    output: z.object({ setupScript: z.string(), env: z.record(z.string(), z.string()) }).strict(),
  },
  run_setup: {
    input: z.object({ cwd: z.string().min(1), recipe: setupRecipeSchema }).strict(),
    output: z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() }).strict(),
  },
  probe_port: {
    input: z.object({ port: z.number().int().min(1).max(65_535) }).strict(),
    output: z.object({ state: z.enum(["listening", "closed", "unknown"]) }).strict(),
  },
  allocate_port: {
    input: z.object({}).strict(),
    output: z.object({ port: z.number().int().min(1).max(65_535) }).strict(),
  },
});
