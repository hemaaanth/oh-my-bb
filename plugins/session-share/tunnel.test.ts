import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseQuickTunnelUrl, startCloudflareTunnel } from "./tunnel.js";

describe("parseQuickTunnelUrl", () => {
  it("extracts the published trycloudflare URL from mixed logs", () => {
    expect(
      parseQuickTunnelUrl(
        "2026-08-22 INF Requesting new quick Tunnel\nhttps://paper-sun-42.trycloudflare.com ready",
      ),
    ).toBe("https://paper-sun-42.trycloudflare.com");
  });

  it("does not accept unrelated public URLs", () => {
    expect(parseQuickTunnelUrl("dashboard https://example.com/tunnel")).toBeNull();
  });
});

describe("startCloudflareTunnel", () => {
  it("recognizes a named tunnel connection and redacts its token from logs", async () => {
    const executable = join(
      tmpdir(),
      `bb-session-share-cloudflared-${process.pid}-${Date.now()}`,
    );
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        "process.stderr.write(JSON.stringify({args:process.argv.slice(2),tokenPresent:process.env.TUNNEL_TOKEN==='secret-tunnel-token'}) + '\\n');",
        "process.stderr.write(process.env.TUNNEL_TOKEN.slice(0,8), () => {",
        "  process.stderr.write(process.env.TUNNEL_TOKEN.slice(8)+'\\nRegistered tunnel connection\\n');",
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
        "});",
      ].join("\n"),
      { mode: 0o700 },
    );
    const logs: string[] = [];

    try {
      const tunnel = await startCloudflareTunnel({
        cloudflaredPath: executable,
        localUrl: "http://127.0.0.1:43127",
        mode: "custom",
        customHostname: "review.example.com",
        tunnelToken: "secret-tunnel-token",
        log: (message) => logs.push(message),
        checkReachability: async () => undefined,
      });
      await tunnel.reachable;
      expect(tunnel.publicUrl).toBe("https://review.example.com");
      expect(logs[0]).toBe(JSON.stringify({ args: ["tunnel", "--no-autoupdate", "run"], tokenPresent: true }));
      expect(logs.join("\n")).not.toContain("secret-tunnel-token");
      await tunnel.stop();
      await tunnel.closed;
    } finally {
      await rm(executable, { force: true });
    }
  });
  it("rejects a missing executable without hanging during cleanup", async () => {
    await expect(startCloudflareTunnel({
      cloudflaredPath: join(tmpdir(), "session-share-executable-does-not-exist"),
      localUrl: "http://127.0.0.1:43127",
      mode: "quick",
      log: () => undefined,
      checkReachability: async () => undefined,
    })).rejects.toThrow("cloudflared was not found");
  });
});
