import { connect, createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("docker/preview-supervisor.mjs");
const cleanup: Array<() => Promise<void>> = [];

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not allocate a test port"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for preview state");
}

async function responds(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`);
    return response.status === 200 && (await response.text()) === "restored";
  } catch {
    return false;
  }
}

async function upgradeResponse(
  port: number,
  headers: Record<string, string>,
): Promise<string> {
  return new Promise((resolveResponse, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      const lines = ["GET /socket HTTP/1.1"];
      for (const [name, value] of Object.entries(headers)) {
        lines.push(`${name}: ${value}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolveResponse(response);
      }
    });
    socket.once("error", reject);
  });
}

function signal(process: ChildProcess | number, name: NodeJS.Signals) {
  try {
    if (typeof process === "number") globalThis.process.kill(process, name);
    else process.kill(name);
  } catch {
    // Cleanup is idempotent.
  }
}

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("sandbox preview supervisor", () => {
  it("injects the public URL and proxies HTTP and WebSockets through a canonical loopback origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-preview-test-"));
    const bin = join(root, "bin");
    const publicPort = await freePort();
    const targetPort = await freePort();
    const publicUrl = `https://sandbox--${publicPort}.getbb.test`;
    await mkdir(bin);
    const mockBb = join(bin, "bb");
    await writeFile(
      mockBb,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ url: publicUrl })}'\n`,
    );
    await chmod(mockBb, 0o755);
    const env = {
      ...process.env,
      BB_SANDBOX_PREVIEW_DIR: root,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    cleanup.push(async () => {
      try {
        const pid = Number(
          (await readFile(join(root, "supervisor.pid"), "utf8")).trim(),
        );
        signal(pid, "SIGTERM");
      } catch {
        // The test may have already stopped it.
      }
      await rm(root, { recursive: true, force: true });
    });

    const serverCommand = [
      "-e",
      [
        "const http=require('node:http')",
        "const server=http.createServer((req,res)=>res.end(JSON.stringify({previewUrl:process.env.TEST_PUBLIC_ORIGIN,legacyUrl:process.env.BB_PREVIEW_URL??null,host:req.headers.host,origin:req.headers.origin,referer:req.headers.referer})))",
        "server.on('upgrade',(req,socket)=>socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\nX-Seen-Host: '+req.headers.host+'\\r\\nX-Seen-Origin: '+req.headers.origin+'\\r\\n\\r\\n'))",
        "server.listen(Number(process.argv[1]),'127.0.0.1')",
      ].join(";"),
      String(targetPort),
    ];
    const started = spawnSync(
      process.execPath,
      [
        script,
        "start",
        "--port",
        String(publicPort),
        "--name",
        "canonical-preview",
        "--public-url-env",
        "TEST_PUBLIC_ORIGIN",
        "--canonical-origin",
        `http://localhost:${targetPort}`,
        "--wait-seconds",
        "10",
        "--",
        process.execPath,
        ...serverCommand,
      ],
      { cwd: resolve("."), env, encoding: "utf8", timeout: 15_000 },
    );
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout.trim()).toBe(publicUrl);

    const response = await fetch(`http://127.0.0.1:${publicPort}/headers`, {
      headers: {
        origin: `http://127.0.0.1:${publicPort}`,
        referer: `http://127.0.0.1:${publicPort}/from`,
      },
    });
    expect(await response.json()).toEqual({
      previewUrl: publicUrl,
      legacyUrl: null,
      host: `localhost:${targetPort}`,
      origin: `http://localhost:${targetPort}`,
      referer: `http://localhost:${targetPort}/`,
    });

    const hostile = await fetch(`http://127.0.0.1:${publicPort}/headers`, {
      headers: { origin: "https://attacker.example" },
    });
    expect(hostile.status).toBe(403);

    const upgraded = await upgradeResponse(publicPort, {
      Host: `127.0.0.1:${publicPort}`,
      Connection: "Upgrade",
      Upgrade: "test",
      Origin: `http://127.0.0.1:${publicPort}`,
    });
    expect(upgraded).toContain("101 Switching Protocols");
    expect(upgraded).toContain(`X-Seen-Host: localhost:${targetPort}`);
    expect(upgraded).toContain(
      `X-Seen-Origin: http://localhost:${targetPort}`,
    );

    const spec = JSON.parse(
      await readFile(join(root, "specs", "canonical-preview.json"), "utf8"),
    ) as {
      canonicalOrigin: string;
      publicUrl: string;
      publicUrlEnv: string;
    };
    expect(spec.publicUrl).toBe(publicUrl);
    expect(spec.publicUrlEnv).toBe("TEST_PUBLIC_ORIGIN");
    expect(spec.canonicalOrigin).toBe(`http://localhost:${targetPort}`);
  }, 20_000);

  it("restores a registered preview after the supervisor is restarted", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-preview-test-"));
    const port = await freePort();
    const env = { ...process.env, BB_SANDBOX_PREVIEW_DIR: root };
    cleanup.push(async () => {
      try {
        const pid = Number(
          (await readFile(join(root, "supervisor.pid"), "utf8")).trim(),
        );
        signal(pid, "SIGTERM");
      } catch {
        // The test may have already stopped it.
      }
      await rm(root, { recursive: true, force: true });
    });

    const serverCommand = [
      "-e",
      "require('node:http').createServer((_,r)=>r.end('restored')).listen(Number(process.argv[1]),'127.0.0.1')",
      String(port),
    ];
    const registered = spawnSync(
      process.execPath,
      [
        script,
        "start",
        "--port",
        String(port),
        "--name",
        "test-preview",
        "--wait-seconds",
        "10",
        "--no-expose",
        "--",
        process.execPath,
        ...serverCommand,
      ],
      { cwd: resolve("."), env, encoding: "utf8", timeout: 15_000 },
    );
    expect(registered.status, registered.stderr).toBe(0);
    await waitFor(() => responds(port));

    const firstSupervisor = Number(
      (await readFile(join(root, "supervisor.pid"), "utf8")).trim(),
    );
    signal(firstSupervisor, "SIGTERM");
    await waitFor(async () => !(await responds(port)));
    await waitFor(async () => {
      try {
        await readFile(join(root, "supervisor.pid"), "utf8");
        return false;
      } catch {
        return true;
      }
    });

    // Native machine resume invokes `ensure` after core reconnects its daemon.
    const ensured = spawnSync(process.execPath, [script, "ensure"], {
      cwd: resolve("."), env, encoding: "utf8", timeout: 10_000,
    });
    expect(ensured.status, ensured.stderr).toBe(0);
    const resumedSupervisor = Number(
      (await readFile(join(root, "supervisor.pid"), "utf8")).trim(),
    );
    cleanup.push(async () => signal(resumedSupervisor, "SIGTERM"));
    await waitFor(() => responds(port));

    const spec = JSON.parse(
      await readFile(join(root, "specs", "test-preview.json"), "utf8"),
    ) as { command: string[]; port: number };
    expect(spec.port).toBe(port);
    expect(spec.command[0]).toBe(process.execPath);
  }, 20_000);
});
