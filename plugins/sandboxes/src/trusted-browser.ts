import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { z } from "zod";
import { verifiedBrowserArtifact } from "./browser-artifact.js";
import { sandboxSshHostContract } from './ssh-contract.js';

const browserRuntime = new URL("../docker/browser-runtime.tar", import.meta.url);
const RUNTIME_CHUNK_BYTES = 12 * 1024;

function runtimeInstallCommand(archive: string, digest: string): string {
  const destination = `/opt/bb-browser/runtimes/${digest}`;
  // Keep old runtime files for already-running workers; switch only new CLI calls.
  return `install -d -m 755 ${destination} && tar -xf ${archive} -C ${destination} && chmod 755 ${destination}/docker/trusted-browser.mjs && ln -s ${destination}/docker/trusted-browser.mjs ${archive}.link && mv -Tf ${archive}.link /usr/local/bin/bb-browser`;
}

async function ensureBrowserRuntime(input: Pick<Parameters<typeof provisionTrustedBrowser>[0], "bb" | "executor" | "report" | "signal">): Promise<boolean> {
  let archive: Buffer;
  let digest: string;
  let checksums: string;
  try {
    const artifact = verifiedBrowserArtifact();
    digest = artifact.archiveSha256;
    checksums = Object.entries(artifact.inputs).map(([name, entry]) => `${entry.sha256}  ${name}\n`).join("");
    archive = await readFile(browserRuntime);
    input.bb.log.warn("Sandbox Browser runtime archive verified");
  } catch {
    input.bb.log.warn("Sandbox Browser runtime archive unavailable");
    return false;
  }
  const installed = await input.executor.exec({
    command: ["sh", "-c", 'command -v bb-browser >/dev/null 2>&1 && cd "$(dirname "$(readlink -f "$(command -v bb-browser)")")/.." && sha256sum --check --status'],
    stdin: checksums, timeoutMs: 30_000, signal: input.signal, onOutput: () => {},
  });
  if (installed.exitCode === 0) return true;
  input.report.log("Installing the verified bb-browser runtime for this sandbox.\n");
  const directory = `/tmp/bb-browser-runtime-${randomUUID()}`;
  const stagedArchive = `${directory}/runtime.tar`;
  let exitCode = 1;
  let succeeded = false;
  const run = async (command: string, stdin = "") => {
    const result = await input.executor.exec({ command: ["sh", "-c", command], stdin, timeoutMs: 30_000, signal: input.signal, onOutput: () => {} });
    exitCode = result.exitCode;
    return result.exitCode === 0;
  };
  try {
    if (await run(`install -d -m 700 ${directory} && : > ${stagedArchive} && chmod 600 ${stagedArchive}`)) {
      let complete = true;
      for (let offset = 0; offset < archive.length; offset += RUNTIME_CHUNK_BYTES) {
        if (!await run(`base64 -d >> ${stagedArchive}`, archive.subarray(offset, offset + RUNTIME_CHUNK_BYTES).toString("base64"))) {
          complete = false;
          break;
        }
      }
      if (complete && await run(`printf '%s  %s\\n' '${digest}' '${stagedArchive}' | sha256sum -c -`) && await run(runtimeInstallCommand(stagedArchive, digest))) {
        succeeded = true;
      }
    }
  } catch {
    input.bb.log.warn("Sandbox Browser runtime installer failed (error)");
  } finally {
    try {
      const cleanup = await input.executor.exec({ command: ["sh", "-c", `rm -rf ${directory}`], stdin: "", timeoutMs: 30_000, signal: input.signal, onOutput: () => {} });
      if (cleanup.exitCode !== 0) {
        exitCode = cleanup.exitCode;
        succeeded = false;
      }
    } catch {
      succeeded = false;
    }
  }
  input.bb.log.warn(`Sandbox Browser runtime installer exited ${exitCode}`);
  if (succeeded) return true;
  input.report.log(`Browser runtime installation failed (exit ${exitCode}); this image cannot use bb-browser.\n`);
  return false;
}

export async function provisionTrustedBrowser(input: {
  bb: BbPluginApi; executor: MachineExecutor; report: PluginMachineProviderProgress; signal: AbortSignal;
  hostId: string; enabled: boolean;
}): Promise<void> {
  if (!input.enabled) return;
  let payload: Record<string, unknown> = { userAgent: "", exitNode: "", homeEgressIp: "", tailscaleAuthKey: "", tailscaleUserspace: "1",networkService:'', requiredState: "", state: null };
  if (input.enabled) {
    try {
      payload = await input.bb.sdk.plugins.callRpc({ pluginId: "browser", method: "prepareSandboxV1", input: { hostId: input.hostId }, outputSchema: z.record(z.string(), z.unknown()) });
      input.bb.log.warn("Sandbox Browser opt-in succeeded");
    } catch {
      input.signal.throwIfAborted();
      input.bb.log.warn("Sandbox Browser opt-in unavailable");
      input.report.log("Browser integration unavailable or off; no browser identity was provisioned.\n");
      return;
    }
  }
  try {
    if (!await ensureBrowserRuntime(input)) return;
  } catch {
    input.signal.throwIfAborted();
    input.bb.log.warn("Sandbox Browser runtime availability check failed (error)");
    input.report.log("Browser runtime installation unavailable on this machine.\n");
    return;
  }
  if(!input.enabled||!payload.exitNode||payload.networkService!=='sandboxes-v1'){
    try{const host=await input.bb.sdk.hosts.get({hostId:input.hostId});if(host.status==='connected')await input.bb.hosts.experimental_client({contract:sandboxSshHostContract}).call('releaseBrowserNetwork',{threadId:null},{hostId:input.hostId,signal:input.signal,timeoutMs:30000});}
    catch{input.signal.throwIfAborted();input.report.log('Browser network cleanup pending on this host; SSH was not stopped.\n');}
  }
  try {
    const result = await input.executor.exec({ command: ["bb-browser", "provision"], stdin: JSON.stringify(payload), timeoutMs: 30_000, signal: input.signal, onOutput: () => {} });
    input.bb.log.warn(`Sandbox Browser provisioner exited ${result.exitCode}`);
    if (result.exitCode !== 0) {
      input.report.log(`Browser provisioning failed (exit ${result.exitCode}); bb-browser will refuse incomplete identity.\n`);
      return;
    }
    if (payload.exitNode && payload.networkService === "sandboxes-v1") {
      input.report.log("Browser home-route validation is deferred to the first thread-owned bb-browser command; it will fail closed if the Browser route is unhealthy.\n");
    }
  } catch {
    input.signal.throwIfAborted();
    input.bb.log.warn("Sandbox Browser provisioner failed (error)");
    input.report.log("Browser provisioning unavailable on this machine.\n");
  }
}
