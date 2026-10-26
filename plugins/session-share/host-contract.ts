import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const responseChunkSchema = z
  .object({
    bodyBase64: z.string(),
    continuationToken: z.string().nullable(),
  })
  .strict();

export const hostContract = defineRpcContract({
  fetch: {
    input: z
      .object({
        url: z.string().url(),
      })
      .strict(),
    output: z
      .object({
        status: z.number().int(),
        contentType: z.string(),
        location: z.string().nullable(),
        bodyBase64: z.string(),
        continuationToken: z.string().nullable(),
      })
      .strict(),
  },
  fetchChunk: {
    input: z.object({ continuationToken: z.string().min(1) }).strict(),
    output: responseChunkSchema,
  },
  discardResponse: {
    input: z.object({ continuationToken: z.string().min(1) }).strict(),
    output: z.object({ discarded: z.boolean() }).strict(),
  },
});
