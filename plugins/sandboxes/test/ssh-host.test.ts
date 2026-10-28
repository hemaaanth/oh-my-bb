import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxNetworkHost } from "../src/network-host.js";

const directories: string[] = [];
const running: SandboxNetworkHost[] = [];
const SECRET = "tskey-auth-test-only";
afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.stop(new AbortController().signal)));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "bb-ssh-test-"));
  directories.push(directory);
  const executable = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.BB_SSH_TEST_DIRECTORY;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(args) + '\\n');
if (args.includes('version') || args.includes('--version')) process.exit(0);
if (process.argv[1].endsWith('/tailscaled')) {
  fs.writeFileSync(path.join(root, 'daemon'), JSON.stringify(args));
  process.on('SIGTERM', () => { fs.rmSync(path.join(root, 'daemon'), {force:true}); process.exit(0); });
  setInterval(() => {}, 1000);
} else
if (args.includes('status')) {
  if (fs.existsSync(path.join(root, 'require-daemon')) && !fs.existsSync(path.join(root, 'daemon'))) process.exit(1);
  const ready = fs.existsSync(path.join(root, 'ready'));
  console.log(JSON.stringify({BackendState:ready?'Running':'NeedsLogin',Self:ready?{ID:'node-test',DNSName:'bb-host-test.tailnet.ts.net.'}:{ID:'',DNSName:''}}));
  if (!ready) process.exitCode = 1;
} else if (args.includes('up')) {
  if (fs.existsSync(path.join(root, 'required-up-flag')) && !args.includes(fs.readFileSync(path.join(root, 'required-up-flag'),'utf8'))) { console.error('changing settings via tailscale up requires mentioning all non-default flags'); process.exit(1); }
  const file = args.find(arg => arg.startsWith('--auth-key=file:')).slice('--auth-key=file:'.length);
  fs.writeFileSync(path.join(root, 'enrollment'), JSON.stringify({key:fs.readFileSync(file,'utf8'),mode:fs.statSync(file).mode&0o777,file}));
  if (fs.existsSync(path.join(root, 'fail-up'))) { console.error('secret ' + fs.readFileSync(file,'utf8')); process.exit(1); }
  fs.writeFileSync(path.join(root, 'ready'), '1');
} else if (args.includes('set') && fs.existsSync(path.join(root, 'fail-set'))) process.exit(1);
`;
  await writeFile(join(directory, "tailscale"), executable, { mode: 0o700 });
  await writeFile(join(directory, "tailscaled"), executable, { mode: 0o700 });
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  vi.stubEnv("BB_SSH_TEST_DIRECTORY", directory);
  vi.spyOn(process, "getuid").mockReturnValue(0);
  const storage = join(directory, "state");
  const host = new SandboxNetworkHost(storage);
  running.push(host);
  const input = { hostId: "host_test", authKey: SECRET };
  const signal = new AbortController().signal;
  const calls = async (): Promise<string[][]> => (await readFile(join(directory, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { directory, storage, host, input, signal, calls };
}

describe("sandbox SSH host worker", () => {
  it.each(["ssh", "browser"] as const)("repeats the existing %s preference during enrollment", async (kind) => {
    const { directory, storage, input, signal, calls } = await setup();
    const flag = kind === "ssh" ? "--ssh=true" : "--exit-node=home-node";
    await writeFile(join(directory, "required-up-flag"), flag);
    const network = new SandboxNetworkHost(storage, kind);
    running.push(network);
    await network.acquire("owner", { ...input, ...(kind === "browser" ? { exitNode: "home-node" } : {}) }, signal);
    expect((await calls()).find(args => args.includes("up"))).toContain(flag);
  });

  it("starts a private userspace daemon and resumes with the existing node state", async () => {
    const { directory, host, input, signal, calls } = await setup();
    await writeFile(join(directory, "require-daemon"), "1");
    await host.configure(input, signal);
    const args = JSON.parse(await readFile(join(directory, "daemon"), "utf8"));
    expect(args).toContain("--tun=userspace-networking");
    expect(args.some((arg: string) => arg.startsWith("--socket="))).toBe(true);
    await host.stop(signal);
    await expect(readFile(join(directory, "daemon"))).rejects.toMatchObject({ code: "ENOENT" });
    await host.configure(input, signal);
    expect((await calls()).filter((args) => args.includes("up"))).toHaveLength(1);
  });
  it('retains Browser egress until the last persisted thread releases it',async()=>{
    const {directory,storage,input,signal,calls}=await setup();await writeFile(join(directory,'require-daemon'),'1');
    const network=new SandboxNetworkHost(storage,'browser');running.push(network);
    const first=await network.acquire('threadA',{...input,exitNode:'approved-home'},signal);await network.acquire('threadB',{...input,exitNode:'approved-home'},signal);
    await expect(network.acquire('threadC',{...input,exitNode:'different-home'},signal)).rejects.toThrow('Close all');
    expect(await network.release('threadA',signal)).toBe(1);expect(JSON.parse(await readFile(join(directory,'daemon'),'utf8'))).toContain(`--socks5-server=127.0.0.1:${first.proxyPort}`);
    const restarted=new SandboxNetworkHost(storage,'browser');running.push(restarted);expect(await restarted.release('threadB',signal)).toBe(0);
    await expect(readFile(join(directory,'daemon'))).rejects.toMatchObject({code:'ENOENT'});expect((await calls()).filter(args=>args.includes('logout'))).toHaveLength(1);
  });
  it('ignores stale and legacy cleanup after a Browser session is replaced', async () => {
    const { directory, storage, input, signal, calls } = await setup();
    await writeFile(join(directory, 'require-daemon'), '1');
    const network = new SandboxNetworkHost(storage, 'browser'); running.push(network);
    const oldGeneration = 'a'.repeat(32), generation = 'b'.repeat(32);
    await network.acquire('threadA', { ...input, exitNode: 'approved-home', generation: oldGeneration }, signal);
    await network.acquire('threadA', { ...input, exitNode: 'approved-home', generation }, signal);
    await network.acquire('threadB', { ...input, exitNode: 'approved-home' }, signal);
    const restarted = new SandboxNetworkHost(storage, 'browser'); running.push(restarted);
    expect(await restarted.release('threadA', signal, oldGeneration)).toBe(2);
    expect(await restarted.release('threadA', signal)).toBe(2);
    expect((await calls()).filter(args => args.includes('logout'))).toHaveLength(0);
    expect(await restarted.release('threadA', signal, generation)).toBe(1);
    expect((await calls()).filter(args => args.includes('logout'))).toHaveLength(0);
    expect(await restarted.release('threadB', signal)).toBe(0);
    expect((await calls()).filter(args => args.includes('logout'))).toHaveLength(1);
  });
  it('releases SSH and Browser independently without stopping the other process',async()=>{
    const ssh=await setup();await writeFile(join(ssh.directory,'require-daemon'),'1');await ssh.host.acquire('ssh',ssh.input,ssh.signal);
    const browser=await setup();await writeFile(join(browser.directory,'require-daemon'),'1');const network=new SandboxNetworkHost(browser.storage,'browser');running.push(network);await network.acquire('threadA',{...browser.input,exitNode:'approved-home'},browser.signal);
    const browserPid=Number(await readFile(join(browser.storage,'tailscaled.pid'),'utf8'));await ssh.host.release('ssh',ssh.signal);expect(process.kill(browserPid,0)).toBe(true);
    vi.stubEnv('BB_SSH_TEST_DIRECTORY',ssh.directory);await ssh.host.acquire('ssh',ssh.input,ssh.signal);const sshPid=Number(await readFile(join(ssh.storage,'tailscaled.pid'),'utf8'));
    vi.stubEnv('BB_SSH_TEST_DIRECTORY',browser.directory);await network.release('threadA',browser.signal);expect(process.kill(sshPid,0)).toBe(true);
  });


  it("enrolls with a private temporary key file, then reuses state on resume", async () => {
    const { directory, storage, host, input, signal, calls } = await setup();
    const result = await host.configure(input, signal);
    expect(result).toMatchObject({ nodeId: "node-test", error: null });
    expect(result.authority).toMatch(/@bb-host-test\.tailnet\.ts\.net$/);
    const enrollment = JSON.parse(await readFile(join(directory, "enrollment"), "utf8"));
    expect(enrollment).toMatchObject({ key: SECRET, mode: 0o600 });
    expect((await readdir(storage)).some((name) => name.startsWith("enroll-"))).toBe(false);
    await host.configure(input, signal);
    const arguments_ = await calls();
    expect(arguments_.filter((args) => args.includes("up"))).toHaveLength(1);
    expect(arguments_.filter((args) => args.includes("set") && args.includes("--ssh=true"))).toHaveLength(2);
    expect(JSON.stringify(arguments_)).not.toContain(SECRET);
    expect(JSON.stringify(arguments_)).not.toContain("--reset");
    expect(JSON.stringify(arguments_)).not.toContain("--exit-node");
  });

  it("removes the enrollment key after failure and hides raw Tailscale output", async () => {
    const { directory, storage, host, input, signal } = await setup();
    await writeFile(join(directory, "fail-up"), "1");
    await expect(host.configure(input, signal)).rejects.toThrow("Tailscale enrollment failed");
    try { await host.configure(input, signal); }
    catch (error) { expect(String(error)).not.toContain(SECRET); }
    expect((await readdir(storage)).some((name) => name.startsWith("enroll-"))).toBe(false);
  });

  it("returns the enrolled device for cleanup if enabling SSH fails", async () => {
    const { directory, host, input, signal } = await setup();
    await writeFile(join(directory, "fail-set"), "1");
    expect(await host.configure(input, signal)).toMatchObject({ nodeId: "node-test", error: expect.stringContaining("SSH policy") });
  });

  it("rejects an unprivileged host without starting Tailscale", async () => {
    const { host, input, signal } = await setup();
    vi.mocked(process.getuid!).mockReturnValue(1000);
    await expect(host.configure(input, signal)).rejects.toThrow("running as root");
  });

  it("does not signal a reused PID belonging to another process", async () => {
    const { storage, host, input, signal } = await setup();
    await host.configure(input, signal);
    await writeFile(join(storage, "tailscaled.pid"), String(process.pid));
    const kill = vi.spyOn(process, "kill");
    await host.stop(signal);
    expect(kill).not.toHaveBeenCalled();
  });

  it("rejects a mismatched download checksum before extracting binaries", async () => {
    const { directory, host, input, signal } = await setup();
    vi.stubEnv("PATH", join(directory, "missing"));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("archive"))
      .mockResolvedValueOnce(new Response("0".repeat(64)));
    await expect(host.configure(input, signal)).rejects.toThrow("checksum mismatch");
    expect(await readdir(directory)).not.toContain("tailscale.tgz");
  });
});
