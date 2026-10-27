import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { runtimeEnvironmentContract } from "./runtime-environment-contract.js";
import { sandboxProviderValues } from "./backend.js";

/** Resolve HOME on the execution host, not on the BB server. Provider APIs may
 * launch the daemon without HOME, even when the image entrypoint exports it. */
export function registerRuntimeEnvironment(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: runtimeEnvironmentContract });
  const registered = new Set<string>();
  const register = (id: string) => {
    if (registered.has(id)) return;
    bb.providers.experimental_contributeEnv(id, async ({ hostId }) => {
      const machine = await bb.sdk.hosts.get({ hostId });
      if (!sandboxProviderValues.some(value => machine.machineProviderId === `sandbox-${value}`)) return [];
      const environment = await host.call("runtimeEnvironment", null, { hostId });
      return [{ name: "HOME", value: environment.home, reason: "Sandbox execution user's home directory" }];
    });
    registered.add(id);
  };
  // Do not await catalog in the factory: it waits for all plugin factories.
  for (const id of ["agents", "claude-code", "codex", "acp-omp", "acp-cursor", "acp-fx", "acp-nanocodex", "pi", "acp-prime-agent"]) register(id);
  bb.background.service("sandbox-runtime-environment", {
    async start(signal) {
      for (const provider of await bb.sdk.providers.catalog()) {
        if (signal.aborted) return;
        register(provider.id);
      }
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
}
