import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = fileURLToPath(new URL("./eval-guidance.mjs", import.meta.url));
describe("eval endpoint refusal", () => {
  it.each([
    "https://api.x.ai/v1", "https://x.ai/v1", "https://API.X.AI./v1",
    "https://openrouter.ai/api/v1", "https://api.openrouter.ai/v1", "https://private-grok.example/v1",
  ])("rejects %s before git, native parsing or Claude can start", endpoint => {
    const result = spawnSync(process.execPath, [runner, "--model", "sonnet", "--approved-route", "gateway", "--out", "/tmp/pages-refused-route"], {
      env: { ...process.env, PATH: "", ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: "synthetic-test-token" },
      encoding: "utf8", timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error: Prohibited provider in ANTHROPIC_BASE_URL");
    expect(result.stderr).not.toContain("synthetic-test-token");
    expect(result.stderr).not.toContain("spawnSync git");
  });
});
