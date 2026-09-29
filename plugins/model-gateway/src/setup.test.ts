import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  gatewayBaseUrl,
  ompSnippet,
  upsertOmpProvider,
  writeOmpProvider,
} from "./setup.js";

const URL_A = gatewayBaseUrl("http://127.0.0.1:38886/");
const URL_B = gatewayBaseUrl("http://127.0.0.1:40000");

describe("bb gateway setup omp", () => {
  it("builds the gateway base URL from a server URL", () => {
    expect(URL_A).toBe(
      "http://127.0.0.1:38886/api/v1/plugins/model-gateway/http/v1",
    );
  });

  it("adds the block under an existing providers key and keeps every other byte", () => {
    const before = [
      "# my omp models",
      "providers:",
      "    local:",
      "        baseUrl: http://localhost:11434/v1",
      "        apiKey: OLLAMA_KEY",
      "modelOverrides: {}",
      "",
    ].join("\n");
    const after = upsertOmpProvider(before, URL_A);
    expect(after).toContain(
      "\n    model-gateway:\n        baseUrl: http://127.0.0.1:38886/api/v1/plugins/model-gateway/http/v1\n        apiKey: MODEL_GATEWAY_TOKEN\n",
    );
    // Removing the managed block gives back the original file exactly.
    const stripped = after.replace(
      /\n# >>> model-gateway[\s\S]*?# <<< model-gateway/u,
      "",
    );
    expect(stripped).toBe(before);
    // A second run replaces only the block.
    const updated = upsertOmpProvider(after, URL_B);
    expect(updated).toBe(after.replace(URL_A, URL_B));
    expect(upsertOmpProvider(updated, URL_B)).toBe(updated);
  });

  it("appends a providers key when the file has none, and refuses what it cannot edit", () => {
    expect(upsertOmpProvider("", URL_A)).toBe(ompSnippet(URL_A));
    expect(upsertOmpProvider("defaultModel: x", URL_A)).toBe(
      `defaultModel: x\n${ompSnippet(URL_A)}`,
    );
    expect(() => upsertOmpProvider("providers: {}\n", URL_A)).toThrow(
      /cannot edit/u,
    );
    expect(() =>
      upsertOmpProvider("providers:\n  model-gateway:\n    api: x\n", URL_A),
    ).toThrow(/unmanaged model-gateway/u);
  });

  it("writes models.yml under a home, backing up an existing file", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "mgw-omp-home-"));
    try {
      const file = path.join(home, ".omp", "agent", "models.yml");
      const created = await writeOmpProvider(home, URL_A, 1);
      expect(created).toEqual({ file, backup: null, changed: true });
      expect(await fs.readFile(file, "utf8")).toBe(ompSnippet(URL_A));

      const moved = await writeOmpProvider(home, URL_B, 2);
      expect(moved).toEqual({ file, backup: `${file}.bak-2`, changed: true });
      expect(await fs.readFile(`${file}.bak-2`, "utf8")).toBe(
        ompSnippet(URL_A),
      );
      expect(await writeOmpProvider(home, URL_B, 3)).toEqual({
        file,
        backup: null,
        changed: false,
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
