import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { runtimeEnvironmentContract } from "./runtime-environment-contract.js";
import { sandboxProviderValues } from "./backend.js";

/** Resolve HOME on the execution host, not on the BB server. Provider APIs may
 * launch the daemon without HOME, even when the image entrypoint exports it.
 * Also mark the agent's environment as a sandbox. */
export function registerRuntimeEnvironment(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: runtimeEnvironmentContract });
  const registered = new Set<string>();
  const register = (id: string) => {
    if (registered.has(id)) return;
    bb.providers.experimental_contributeEnv(id, async ({ hostId }) => {
      const machine = await bb.sdk.hosts.get({ hostId });
      const provider = sandboxProviderValues.find(value => machine.machineProviderId === `sandbox-${value}`);
      if (!provider) return [];
      const environment = await host.call("runtimeEnvironment", null, { hostId });
      // BB core starts the daemon, not the image entrypoint, so agents never see
      // the entrypoint's IS_SANDBOX. Supply it here so agents know where they run.
      return [
        { name: "HOME", value: environment.home, reason: "Sandbox execution user's home directory" },
        { name: "IS_SANDBOX", value: "1", reason: "This thread runs on a bb sandbox" },
        { name: "BB_SANDBOX_PROVIDER", value: provider, reason: "The provider hosting this sandbox" },
      ];
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
