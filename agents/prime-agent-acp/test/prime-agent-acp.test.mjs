import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import net from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { launchArgs, primeConfig, main, shutdownDaemon } from "../prime-agent-acp.mjs";

const adapter = fileURLToPath(new URL("../prime-agent-acp.mjs", import.meta.url));

describe("Prime gateway adapter", () => {
  it("splits provider/model without splitting slashes inside the model id", () => {
    const selected = launchArgs(["--mode", "acp", "--model", "model-gateway/openai/gpt-6-sol", "--cwd", "/tmp/with spaces"]);
    expect(selected.model).toBe("openai/gpt-6-sol");
    expect(selected.args).toEqual(["--offline", "--provider", "model-gateway", "--model", "openai/gpt-6-sol", "--mode", "acp", "--cwd", "/tmp/with spaces"]);
  });

  it("rejects direct providers and auth/socket overrides instead of escaping the gateway", () => {
    for (const args of [["--model", "openai-codex/gpt-6-sol"], ["--provider=openai"], ["--api-key", "not-used"], ["--daemon-socket", "/tmp/shared"]])
      expect(() => launchArgs(args)).toThrow();
    expect(() => launchArgs(["--model"])).toThrow(/requires/);
  });

  it("keeps an env reference on disk and registers the selected custom model", () => {
    const config = primeConfig("https://host.example/v1/", ["gpt-6-sol", "custom/model"]);
    expect(config.providers["model-gateway"]).toMatchObject({
      apiKey: "MODEL_GATEWAY_TOKEN", baseUrl: "https://host.example/v1", api: "openai-responses", authHeader: true,
    });
    expect(config.providers["model-gateway"].models.map(({ id }) => id)).toEqual(["gpt-6-sol", "custom/model"]);
  });

  it("rejects URLs that could leak a credential into the config file", () => {
    for (const url of ["https://user:password@example.com/v1", "https://example.com/v1?token=secret", "file:///tmp/example"])
      expect(() => primeConfig(url, ["model"])).toThrow(/HTTP/);
  });

  it("fails closed before starting Prime without both gateway env entries", async () => {
    await expect(main(["--mode", "acp"], {})).rejects.toThrow(/no local Prime login fallback/);
    const result = spawnSync(process.execPath, [adapter], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODEL_GATEWAY_BASE_URL and MODEL_GATEWAY_TOKEN are required");
    expect(result.stdout).toBe("");
  });

  it("lists gateway model ids in the shim's provider/model format without a login", () => {
    const output = execFileSync(process.execPath, [adapter, "model-list"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    expect(output.split("\n")).toContain("model-gateway/gpt-6-sol - gpt-6-sol (model-gateway)");
    expect(output).not.toContain("openai-codex/");
  });

  it("stops its private daemon without connecting to another daemon", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "pa-stop-"));
    const peer = net.createServer();
    const target = net.createServer((socket) => {
      socket.write(`${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } })}\n`);
      const lines = createInterface({ input: socket });
      lines.once("line", (line) => {
        const message = JSON.parse(line);
        if (message.type === "command" && message.protocol.version === 7 &&
            message.command.type === "shutdown" && message.command.force === true) {
          target.close();
        }
        lines.close(); socket.end();
      });
    });
    let peerConnections = 0;
    peer.on("connection", (socket) => { peerConnections++; socket.destroy(); });
    try {
      peer.listen(path.join(root, "peer.sock")); target.listen(path.join(root, "target.sock"));
      await Promise.all([once(peer, "listening"), once(target, "listening")]);
      await shutdownDaemon(path.join(root, "target.sock"));
      expect(target.listening).toBe(false);
      expect(peer.listening).toBe(true);
      expect(peerConnections).toBe(0);
    } finally {
      if (peer.listening) peer.close();
      if (target.listening) target.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
