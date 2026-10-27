import { isAbsolute } from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const runtimeEnvironmentContract = defineRpcContract({
  runtimeEnvironment: {
    input: z.null(),
    output: z.object({ home: z.string().refine(isAbsolute, "HOME must be absolute") }).strict(),
  },
});
