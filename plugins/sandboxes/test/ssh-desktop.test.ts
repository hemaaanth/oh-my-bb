import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxSshDesktop } from "../src/ssh-desktop.js";

const exec = promisify(execFile);
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map((dispose) => dispose())); });

async function setup(serverUrl = "http://127.0.0.1:38886") {
  const directory = await mkdtemp(join(tmpdir(), "bb-ssh-desktop-"));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const sshConfig = join(directory, "config");
  const storage = join(directory, "plugin's files");
  const desktop = new SandboxSshDesktop(storage, sshConfig, () => serverUrl);
  return { directory, sshConfig, storage, desktop };
}

describe("local sandbox SSH configuration", () => {
  it("keeps a dotfile-manager symlink intact", async () => {
    const { desktop, sshConfig, directory } = await setup();
    const dotfile = join(directory, "dotfile");
    await writeFile(dotfile, "Host personal\n  HostName personal.example\n");
    await symlink(dotfile, sshConfig);
    await desktop.configure("host_test", "root@bb-host.tailnet.ts.net");
    expect((await lstat(sshConfig)).isSymbolicLink()).toBe(true);
    expect(await readFile(dotfile, "utf8")).toContain("Host personal");
    expect(await readFile(dotfile, "utf8")).toContain("Include ");
  });

  it("preserves existing SSH configuration, installs one include, and removes only its target", async () => {
    const { desktop, sshConfig, storage } = await setup();
    const original = "Host personal\n  HostName my-server\n";
    await writeFile(sshConfig, original);
    await desktop.configure("host_test", "root@bb-host.tailnet.ts.net");
    await desktop.configure("host_test", "root@bb-host.tailnet.ts.net");
    const configured = await readFile(sshConfig, "utf8");
    expect(configured).toContain(original);
    expect(configured.match(/^Include /gm)).toHaveLength(1);
    const parsed = await exec("ssh", ["-G", "-F", sshConfig, "bb-sandbox-host_test"]);
    expect(parsed.stdout).toContain("hostname bb-host.tailnet.ts.net");
    expect(parsed.stdout).toContain("user root");
    expect(parsed.stdout).toContain("proxycommand env ELECTRON_RUN_AS_NODE=1");
    await exec(process.execPath, ["--check", join(storage, "ssh-proxy.mjs")]);
    await desktop.remove("host_test");
    await expect(readFile(join(storage, "ssh-targets", "host_test.conf"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sshConfig, "utf8")).toBe(configured);
  });

  it("prepares the host before carrying the SSH stream and uses the fresh address", async () => {
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ url: request.url, input: JSON.parse(body) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: { authority: "root@new-address.tailnet.ts.net" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    disposers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const { directory, sshConfig, desktop } = await setup(`http://127.0.0.1:${address.port}`);
    await desktop.configure("host_test", "root@old-address.tailnet.ts.net");
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "tailscale"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const parsed = await exec("ssh", ["-G", "-F", sshConfig, "bb-sandbox-host_test"]);
    const command = parsed.stdout.split("\n").find((line) => line.startsWith("proxycommand "))!.slice("proxycommand ".length);
    const proxy = await exec("sh", ["-c", command.replaceAll("%p", "22")], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(requests).toEqual([{ url: "/api/v1/plugins/sandboxes/rpc/prepareSsh", input: { hostId: "host_test" } }]);
    expect(JSON.parse(proxy.stdout)).toEqual(["nc", "new-address.tailnet.ts.net", "22"]);
  });

  it("rejects invalid host ids before writing configuration", async () => {
    const { desktop } = await setup();
    await expect(desktop.configure("../../another-file", "root@host")).rejects.toThrow("Invalid sandbox host id");
  });
});
