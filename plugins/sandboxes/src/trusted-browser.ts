import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { z } from "zod";
import { sandboxSshHostContract } from './ssh-contract.js';

export async function provisionTrustedBrowser(input: {
  bb: BbPluginApi; executor: MachineExecutor; report: PluginMachineProviderProgress; signal: AbortSignal;
  hostId: string; enabled: boolean;
}): Promise<void> {
  if (!input.enabled) return;
  let payload: Record<string, unknown> = { userAgent: "", exitNode: "", homeEgressIp: "", tailscaleAuthKey: "", tailscaleUserspace: "1",networkService:'', requiredState: "", state: null };
  if (input.enabled) {
    try {
      payload = await input.bb.sdk.plugins.callRpc({ pluginId: "browser", method: "prepareSandboxV1", input: { hostId: input.hostId }, outputSchema: z.record(z.string(), z.unknown()) });
    } catch {
      input.signal.throwIfAborted();
      input.report.log("Browser integration unavailable or off; no browser identity was provisioned.\n");
      return;
    }
  }
  if(!input.enabled||!payload.exitNode||payload.networkService!=='sandboxes-v1'){
    try{const host=await input.bb.sdk.hosts.get({hostId:input.hostId});if(host.status==='connected')await input.bb.hosts.experimental_client({contract:sandboxSshHostContract}).call('releaseBrowserNetwork',{threadId:null},{hostId:input.hostId,signal:input.signal,timeoutMs:30000});}
    catch{input.signal.throwIfAborted();input.report.log('Browser network cleanup pending on this host; SSH was not stopped.\n');}
  }
  try {
    const result = await input.executor.exec({ command: ["sh", "-c", "command -v bb-browser >/dev/null 2>&1 || exit 3; exec bb-browser provision"], stdin: JSON.stringify(payload), timeoutMs: 30_000, signal: input.signal, onOutput: () => {} });
    if (result.exitCode !== 0 && result.exitCode !== 3) input.report.log(`Browser provisioning failed (exit ${result.exitCode}); bb-browser will refuse incomplete identity.\n`);
  } catch { input.signal.throwIfAborted(); input.report.log("Browser provisioning unavailable on this machine.\n"); }
}
