import { describe, expect, it } from "vitest";
import {
  RESPONSE_CHUNK_BYTES,
  chunkResponseBody,
  readResponseBody,
} from "./host.js";

describe("shared preview host responses", () => {
  it("chunks large assets below the host RPC output ceiling", () => {
    const body = Buffer.alloc(13 * 1024 * 1024, 0x61);
    const chunks: Buffer[] = [];
    let offset: number | null = 0;

    while (offset !== null) {
      const encoded = chunkResponseBody(body, offset);
      expect(Buffer.byteLength(encoded.bodyBase64, "utf8")).toBeLessThan(
        8 * 1024 * 1024,
      );
      chunks.push(Buffer.from(encoded.bodyBase64, "base64"));
      offset = encoded.nextOffset;
    }

    expect(RESPONSE_CHUNK_BYTES).toBeLessThan(body.length);
    expect(Buffer.compare(Buffer.concat(chunks), body)).toBe(0);
  });

  it("cancels an unbounded response once it exceeds the configured limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(
      readResponseBody(response, 2 * 1024 * 1024),
    ).rejects.toThrow("exceeded the 2 MiB limit");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(4);
  });
});
