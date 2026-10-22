import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  allocate_port: {
    input: z.object({}).strict(),
    output: z.object({ port: z.number().int().min(1).max(65_535) }).strict(),
  },
});
