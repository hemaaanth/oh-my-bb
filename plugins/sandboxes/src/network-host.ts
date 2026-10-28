import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile,rename } from "node:fs/promises";
import { arch, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { createServer } from 'node:net';

const exec = promisify(execFile);
const VERSION = "1.102.3";
const consumerSchema = z.union([z.string(), z.object({id:z.string(),generation:z.string().regex(/^[a-f0-9]{32}$/)}).strict()]);
type Consumer = z.infer<typeof consumerSchema>;
const consumerId = (owner:Consumer) => typeof owner === 'string' ? owner : owner.id;
const statusSchema = z.object({
  BackendState: z.string(),
  Self: z.object({ ID: z.string(), DNSName: z.string() }).nullable().optional(),
});

// One lifecycle implementation; separate identity directories preserve each consumer's policy.
export class SandboxNetworkHost {
  constructor(private readonly directory: string,private readonly kind:'ssh'|'browser'='ssh') {}

  private async consumers():Promise<Consumer[]>{try{return z.array(consumerSchema).parse(JSON.parse(await readFile(join(this.directory,'consumers.json'),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}}
  private async saveConsumers(owners:Consumer[]){await mkdir(this.directory,{recursive:true,mode:0o700});const file=join(this.directory,'consumers.json'),temporary=file+'.'+process.pid;await writeFile(temporary,JSON.stringify(owners),{mode:0o600});await rename(temporary,file);}
  async acquire(consumer:string,input:{hostId:string;authKey:string;exitNode?:string;generation?:string},signal:AbortSignal){
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(consumer))throw Error('Invalid network consumer');
    if(input.generation&&!/^[a-f0-9]{32}$/.test(input.generation))throw Error('Invalid network generation');
    const owners=await this.consumers(),index=owners.findIndex(owner=>consumerId(owner)===consumer);if(index===-1&&owners.length>=256)throw Error('Network consumer capacity reached');
    if(this.kind==='browser'&&owners.length){const prior=await readFile(join(this.directory,'exit-node'),'utf8');if(prior!==input.exitNode)throw Error('Close all Browser network consumers before changing the exit node');}
    const result=await this.configure(input,signal);
    const owner=input.generation?{id:consumer,generation:input.generation}:index===-1?consumer:owners[index];
    if(index===-1)owners.push(owner);else owners[index]=owner;
    if(this.kind==='browser')await writeFile(join(this.directory,'exit-node'),input.exitNode!,{mode:0o600});
    await this.saveConsumers(owners);return result;
  }
  async release(consumer:string|null,signal:AbortSignal,generation?:string){
    const owners=await this.consumers(),remaining=consumer===null?[]:owners.filter(owner=>consumerId(owner)!==consumer||(typeof owner==='string'?generation!==undefined:owner.generation!==generation));
    // A delayed monitor or an older runtime must not release a replacement.
    if(consumer!==null&&remaining.length===owners.length)return remaining.length;
    if(!remaining.length){
      if(this.kind==='browser'&&owners.length){const {client}=await this.binaries(signal);await this.run(client,[`--socket=${this.socket()}`,'logout'],signal);}
      await this.stop(signal);
    }
    await this.saveConsumers(remaining);return remaining.length;
  }
  async referenced(){return (await this.consumers()).length>0;}

  private socket() { return join(this.directory, "tailscaled.sock"); }

  private async run(binary: string, args: string[], signal?: AbortSignal) {
    try {
      return await exec(binary, args, { timeout: 90_000, maxBuffer: 1024 * 1024, signal });
    } catch {
      // Tailscale diagnostics can contain login URLs. Do not forward raw output.
      throw new Error(`Sandbox SSH: ${args.includes("up") ? "Tailscale enrollment failed" : "Tailscale command failed"}`);
    }
  }

  private async binaries(signal: AbortSignal) {
    try {
      await exec("tailscale", ["version"], { timeout: 5000, signal });
      await exec("tailscaled", ["--version"], { timeout: 5000, signal });
      return { client: "tailscale", daemon: "tailscaled" };
    } catch {
      if (signal.aborted) throw new Error("Sandbox SSH setup cancelled");
    }
    // Box/custom images may not include Tailscale. Install only into plugin storage.
    const platform = arch() === "x64" ? "amd64" : arch() === "arm64" ? "arm64" : null;
    if (platform === null) throw new Error("Sandbox SSH requires Linux amd64 or arm64");
    const extracted = join(this.directory, `tailscale_${VERSION}_${platform}`);
    try {
      await exec(join(extracted, "tailscale"), ["version"], { timeout: 5000, signal });
      return { client: join(extracted, "tailscale"), daemon: join(extracted, "tailscaled") };
    } catch {}
    const url = `https://pkgs.tailscale.com/stable/tailscale_${VERSION}_${platform}.tgz`;
    const [archive, checksum] = await Promise.all([
      fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) }),
      fetch(`${url}.sha256`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }),
    ]);
    if (!archive.ok || !checksum.ok) throw new Error("Could not download sandbox Tailscale");
    const bytes = Buffer.from(await archive.arrayBuffer());
    const expected = (await checksum.text()).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(expected) || createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error("Sandbox Tailscale download checksum mismatch");
    }
    const file = join(this.directory, "tailscale.tgz");
    await writeFile(file, bytes, { mode: 0o600 });
    try {
      await exec("tar", ["xzf", file, "-C", this.directory], { timeout: 30_000, signal });
    } finally {
      await rm(file, { force: true });
    }
    return { client: join(extracted, "tailscale"), daemon: join(extracted, "tailscaled") };
  }

  async configure(input: { hostId: string; authKey: string;exitNode?:string }, signal: AbortSignal) {
    if (process.platform !== "linux" || process.getuid?.() !== 0) {
      throw new Error("Sandbox Tailscale SSH requires a Linux sandbox host worker running as root");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const { client, daemon } = await this.binaries(signal);
    const args = [`--socket=${this.socket()}`];
    let proxyPort=0;
    if(this.kind==='browser'){
      if(!input.exitNode?.trim()||/[\s\0]/.test(input.exitNode))throw Error('Browser network requires an exit node');
      try{proxyPort=Number(await readFile(join(this.directory,'proxy-port'),'utf8'));}catch{}
      if(!Number.isSafeInteger(proxyPort)||proxyPort<1024||proxyPort>65535){const listener=createServer();await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});const address=listener.address();if(!address||typeof address==='string')throw Error('Could not reserve browser proxy port');proxyPort=address.port;await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));await writeFile(join(this.directory,'proxy-port'),String(proxyPort),{mode:0o600});}
    }
    const status = async () => {
      try {
        let stdout: string;
        try {
          stdout = (await exec(client, [...args, "status", "--json"], { timeout: 10_000, signal })).stdout;
        } catch (error) {
          // NeedsLogin/Stopped are valid JSON states even when the CLI exits 1.
          const output = (error as { stdout?: unknown }).stdout;
          if (typeof output !== "string") return null;
          stdout = output;
        }
        return statusSchema.parse(JSON.parse(stdout));
      } catch { return null; }
    };
    let current = await status();
    if (current === null) {
      const log = await open(join(this.directory, "tailscaled.log"), "a", 0o600);
      try {
        const child = spawn(daemon, ["--tun=userspace-networking", `--statedir=${this.directory}`, ...args,...(this.kind==='browser'?[`--socks5-server=127.0.0.1:${proxyPort}`]:[])], {
          detached: true, stdio: ["ignore", log.fd, log.fd],
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        await writeFile(join(this.directory, "tailscaled.pid"), String(child.pid), { mode: 0o600 });
        child.unref();
      } finally { await log.close(); }
      for (let attempt = 0; attempt < 40 && current === null; attempt++) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 250));
        current = await status();
      }
      if (current === null) throw new Error("Sandbox SSH daemon did not start");
    }
    if (current.BackendState !== "Running") {
      const temporary = await mkdtemp(join(this.directory, "enroll-"));
      const keyFile = join(temporary, "auth-key");
      try {
        await writeFile(keyFile, input.authKey, { mode: 0o600 });
        await this.run(client, [...args, "up", `--auth-key=file:${keyFile}`, "--accept-dns=false",
          `--hostname=bb-${input.hostId.replaceAll("_", "-")}`, "--timeout=60s",
          // `up` must repeat all preferences this owner previously set; otherwise
          // Tailscale refuses re-enrollment before attempting authentication.
          ...(this.kind === "ssh" ? ["--ssh=true"] : [`--exit-node=${input.exitNode}`])], signal);
      } finally { await rm(temporary, { recursive: true, force: true }); }
      current = await status();
    }
    if (current?.BackendState !== "Running" || !current.Self?.ID) {
      throw new Error("Sandbox SSH is waiting for Tailscale device approval or login");
    }
    const dnsName = current.Self.DNSName.replace(/\.$/, "");
    const username = userInfo().username;
    if (!/^[a-z0-9][a-z0-9.-]+$/.test(dnsName) || !/^[a-z_][a-z0-9_-]*\$?$/.test(username)) {
      throw new Error("Sandbox SSH returned an invalid hostname or username");
    }
    let error: string | null = null;
    if(this.kind==='ssh'){
      try { await this.run(client, [...args, "set", "--ssh=true"], signal); }
      catch { error = "Could not enable Tailscale SSH; check tailnet SSH policy"; }
    }else await this.run(client,[...args,'set',`--exit-node=${input.exitNode}`],signal);
    // Preserve the enrolled device id so the owning integration can retire it.
    return { nodeId: current.Self.ID, authority: `${username}@${dnsName}`, error, socket:this.socket(),proxyPort,client };
  }

  async stop(signal: AbortSignal) {
    let pid: number;
    try { pid = Number(await readFile(join(this.directory, "tailscaled.pid"), "utf8")); }
    catch { return; }
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    try {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (command.split("\0").includes(`--socket=${this.socket()}`)) {
        signal.throwIfAborted();
        process.kill(pid, "SIGTERM");
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          try {
            const current = await readFile(`/proc/${pid}/cmdline`, "utf8");
            if (!current.split("\0").includes(`--socket=${this.socket()}`)) return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
        }
        // Never let a retiring daemon race the next worker's setup on the same socket.
        const current = await readFile(`/proc/${pid}/cmdline`, "utf8");
        if (current.split("\0").includes(`--socket=${this.socket()}`)) process.kill(pid, "SIGKILL");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
