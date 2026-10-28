import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileGatewaySetup } from "../src/gateway-setup.js";

const homes: string[] = [];
const exec = promisify(execFile);
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const marker = "// managed by model-gateway\n";
const extension = `${marker}export default function gateway() {}\n`;
const file = { path: ".pi/agent/extensions/model-gateway.js", op: "managed-file", marker,
  content: extension, sha256: createHash("sha256").update(extension).digest("hex") };

function setup(files = [file], customPiDir = false, serverBaseUrl = "https://sandbox-server.example") {
  const home = mkdtempSync(join(tmpdir(), "bb-gateway-setup-"));
  homes.push(home);
  const fake = createFakePluginHost({ pluginId: "sandboxes", sdk: { plugins: {
    callRpc: async ({ input, outputSchema }) => {
      expect(input).toEqual({ hostId: "sandbox-host", serverBaseUrl, ...(customPiDir ? { piAgentDirs: [".hempi/agent"] } : {}) });
      return outputSchema.parse({ revision: "setup-revision", files });
    },
  } } });
  const run = async (command: string[], stdin?: string): Promise<string> => {
    const running = exec(command[0]!, command.slice(1), { env: { ...process.env, HOME: home,
      BB_SERVER_URL: "https://sandbox-server.example", PI_CODING_AGENT_DIR: customPiDir ? join(home, ".hempi/agent") : "" }, cwd: home, encoding: "utf8" });
    running.child.stdin!.end(stdin);
    return (await running).stdout;
  };
  return { home, fake, run };
}

describe("sandbox gateway setup", () => {
  it("checks missing files without writing directories, then applies and verifies them", async () => {
    const { home, fake, run } = setup();
    try {
      const checked = await reconcileGatewaySetup(fake.bb, "sandbox-host", run, true);
      expect(checked).toEqual({ revision: "setup-revision", current: false,
        files: [{ path: file.path, status: "missing" }] });
      expect(readdirSync(home)).toEqual([]);
      const applied = await reconcileGatewaySetup(fake.bb, "sandbox-host", run, false);
      expect(applied.current).toBe(true);
      expect(readFileSync(join(home, file.path), "utf8")).toBe(extension);
      expect(await reconcileGatewaySetup(fake.bb, "sandbox-host", run, true)).toEqual(applied);
    } finally { await fake.harness.lifecycle.dispose(); }
  });

  it("prepares through the executor without a daemon URL or host terminals", async () => {
    const { fake, home } = setup([file], false, "http://127.0.0.1:9");
    const executorRun = async (command: string[], stdin?: string) => {
      const running = exec(command[0]!, command.slice(1), {
        env: { ...process.env, HOME: home, BB_SERVER_URL: "", PI_CODING_AGENT_DIR: "" }, cwd: home, encoding: "utf8",
      });
      running.child.stdin!.end(stdin);
      return (await running).stdout;
    };
    try { expect((await reconcileGatewaySetup(fake.bb, "sandbox-host", executorRun, false, true)).current).toBe(true); }
    finally { await fake.harness.lifecycle.dispose(); }
  });

  it("reports the sandbox execution user's custom Pi directory", async () => {
    const { fake, run } = setup([file], true);
    try { expect((await reconcileGatewaySetup(fake.bb, "sandbox-host", run, false)).current).toBe(true); }
    finally { await fake.harness.lifecycle.dispose(); }
  });

  it("keeps unrelated OMP configuration while updating its managed block", async () => {
    const content = "providers:\n# >>> model-gateway (managed by bb gateway setup omp)\n  model-gateway:\n    baseUrl: https://sandbox-server.example/api/v1/plugins/model-gateway/http/v1\n    apiKey: MODEL_GATEWAY_TOKEN\n    authHeader: true\n    api: openai-responses\n    discovery:\n      type: openai-models-list\n# <<< model-gateway\n";
    const omp = { path: ".omp/agent/models.yml", op: "managed-block", marker: "# >>> model-gateway (managed by bb gateway setup omp)",
      content, sha256: createHash("sha256").update(content).digest("hex") };
    const { home, fake, run } = setup([omp]);
    const directory = join(home, ".omp/agent");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "models.yml"), "providers:\n  local-provider:\n    baseUrl: http://localhost:1234\n");
    try {
      expect((await reconcileGatewaySetup(fake.bb, "sandbox-host", run, false)).current).toBe(true);
      const text = readFileSync(join(directory, "models.yml"), "utf8");
      expect(text).toContain("  local-provider:\n    baseUrl: http://localhost:1234\n");
      expect(text).toContain("    baseUrl: https://sandbox-server.example/api/v1/plugins/model-gateway/http/v1");
      expect(readdirSync(directory).filter(name => name.startsWith("models.yml.bak-"))).toHaveLength(1);
    } finally { await fake.harness.lifecycle.dispose(); }
  });

  it("refuses an unmanaged file without replacing it or making a backup", async () => {
    const { home, fake, run } = setup();
    const destination = join(home, file.path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, "// user-owned extension\n");
    try {
      await expect(reconcileGatewaySetup(fake.bb, "sandbox-host", run, false)).rejects.toThrow("not managed");
      expect(readFileSync(destination, "utf8")).toBe("// user-owned extension\n");
      expect(readdirSync(join(destination, ".."))).toEqual(["model-gateway.js"]);
      expect(existsSync(join(home, ".omp"))).toBe(false);
    } finally { await fake.harness.lifecycle.dispose(); }
  });
});
