import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { shQuote } from "./provider/backends/shell-exec.js";

function quote(value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid SSH configuration path");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function read(path: string) {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export function sandboxSshTarget(hostId: string) { return `bb-sandbox-${hostId}`; }

/** Plugin-owned SSH entries let Zed wake a sleeping sandbox through ProxyCommand. */
export class SandboxSshDesktop {
  constructor(private readonly directory: string, private readonly sshConfig: string, private readonly serverUrl: () => string) {}

  async configure(hostId: string, authority: string) {
    if (!/^host_[a-z0-9_]+$/.test(hostId)) throw new Error("Invalid sandbox host id");
    const match = /^([a-z_][a-z0-9_-]*\$?)@([a-z0-9.-]+)$/.exec(authority);
    if (!match) throw new Error("Invalid sandbox SSH authority");
    const entries = join(this.directory, "ssh-targets");
    await mkdir(entries, { recursive: true, mode: 0o700 });
    await chmod(entries, 0o700);
    const helper = join(this.directory, "ssh-proxy.mjs");
    // The loopback RPC carries only a host id. No tailnet credentials go on the desktop.
    await atomicWrite(helper, `import { spawn } from "node:child_process";
const [hostId, port] = process.argv.slice(2);
try {
  if (!/^host_[a-z0-9_]+$/.test(hostId) || port !== "22") throw new Error("Invalid SSH target");
  const response = await fetch(${JSON.stringify(new URL("/api/v1/plugins/sandboxes/rpc/prepareSsh", this.serverUrl()).href)}, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId }), signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error("BB could not prepare the sandbox; check bb sandbox ssh-status");
  const body = await response.json();
  const match = body.ok && /^([a-z_][a-z0-9_-]*\\$?)@([a-z0-9.-]+)$/.exec(body.result?.authority ?? "");
  if (!match) throw new Error("BB returned an invalid sandbox SSH target");
  const child = spawn("tailscale", ["nc", match[2], port], { stdio: "inherit" });
  child.once("error", () => { console.error("Sandbox SSH needs tailscale on this desktop's PATH"); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }
`);
    const target = sandboxSshTarget(hostId);
    // Percent signs in executable paths are expanded by ssh before running a proxy.
    const command = `${shQuote(process.execPath.replaceAll("%", "%%"))} ${shQuote(helper.replaceAll("%", "%%"))}`;
    await atomicWrite(join(entries, `${hostId}.conf`),
      `Host ${target}\n  HostName ${match[2]}\n  User ${match[1]}\n  HostKeyAlias ${target}\n  ConnectTimeout 300\n  ProxyCommand env ELECTRON_RUN_AS_NODE=1 ${command} ${hostId} %p\n`);
    const metadata = await lstat(this.sshConfig).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    // Respect dotfile-manager symlinks, and refuse broken links rather than replacing them.
    const configFile = metadata?.isSymbolicLink() ? await realpath(this.sshConfig) : this.sshConfig;
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
    const include = `Include ${quote(join(entries, "*.conf"))}`;
    const previous = await read(configFile);
    if (!previous.split(/\r?\n/).includes(include)) {
      // Refuse to overwrite a config that changed while this operation was preparing it.
      if (await read(configFile) !== previous) throw new Error("SSH config changed during setup; retry sandbox SSH setup");
      await atomicWrite(configFile, `${include}\n${previous}`);
    }
  }

  async remove(hostId: string) {
    if (!/^host_[a-z0-9_]+$/.test(hostId)) throw new Error("Invalid sandbox host id");
    await rm(join(this.directory, "ssh-targets", `${hostId}.conf`), { force: true });
  }
}
