// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { sandboxIntegrations } from "../src/preferences.js";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { registerNativeProjectEnvironmentSync } from "../src/provider/project-env.js";
import { SandboxPreparationStatus } from "../components/sandbox-settings.js";
const app = await loadPluginApp(() => import("../app.js"));
afterEach(cleanup);
const values = { sshEnabled: false, idleSleepAfter: "15 minutes", defaultSizeTier: "M", copyGitHubCliAuth: false, browserUserAgent: "", browserExitNode: "", browserHomeEgressIp: "" };
const provider = { provider: "freestyle", enabled: true, configured: true, credentialsConfigured: true, apiUrl: "", target: "", sandboxClass: "", appName: "", vmRuntime: false, machineClass: "", environment: "", cpu: "4", memory: "8", storage: "20", persistence: "sticky", snapshotId: "snapshot-original", gatewayEndpoint: "", imageUri: "", supportsImages: false, artifactName: null };
const baseRpc = {
  preferences: () => ({ values, revision: 0, migrationPending: false }),
  imageBuildRepository: () => ({ repository: null, savedRepository: null, source: "unconfigured", imported: false }),
  integrations: () => ({ projectEnvironments: false, catalog: false, agents: false, projects: false }),
  providerSettings: () => ({ providers: [provider] }),
  imageSettings: () => ({ repository: "", platform: "", extraPackages: [], components: [], providers: [] }),
  versionAudit: () => ({ serverVersion: "1", previousServerVersion: null, findings: [], images: [], pins: [], machines: [] }),
  sandboxUpgradeJob: () => null,
};
it("keeps an unsent preferences draft across realtime refresh and failed save", async () => {
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: { ...baseRpc, updatePreferences: () => { throw new Error("fixture save failed"); } } as never });
  const toggle = await slot.findByRole("switch", { name: "Copy GitHub CLI login" });
  fireEvent.click(toggle);
  await slot.behavior.emitRealtime("sandbox-preferences", null);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(slot.getByRole("button", { name: "Save preferences" }));
  await slot.findByText("fixture save failed");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});
it("keeps a provider snapshot draft when metadata refreshes, without view-time capacity or setup", async () => {
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: baseRpc as never });
  const input = await slot.findByPlaceholderText("Freestyle snapshot ID");
  fireEvent.change(input, { target: { value: "snapshot-unsent" } });
  await slot.behavior.emitRealtime("sandbox-provider-settings", { type: "changed" });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("snapshot-unsent"));
  expect(slot.inspection.rpcCalls.some(call => ["daytonaCapacity", "startSandboxUpgrade", "buildImage", "updateThreadAttachments"].includes(call.method))).toBe(false);
});

it("does not restore another client's revoked integration when a stale settings panel changes Catalog", async () => {
  const host = createFakePluginHost({ pluginId: "sandboxes" });
  try {
    const state = sandboxIntegrations(host.bb);
    await state.import({
      schemaVersion: 1, sourceGeneration: "synthetic-existing-baseline", sourceSemanticDigest: "d".repeat(64),
      values: { projectEnvironments: true, catalog: true, agents: true, projects: true },
    });
    const sharedRpc = {
      ...baseRpc,
      integrations: () => state.read(),
      updateIntegrations: (input: unknown) => state.update(input as Parameters<typeof state.update>[0]),
    };
    const a = renderSlot(app.settingsSections[0]!, {}, { rpc: sharedRpc as never });
    const b = renderSlot(app.settingsSections[0]!, {}, { rpc: sharedRpc as never });
    const aCredentials = await within(a.container).findByRole("switch", { name: "Enable Credentials integration" });
    const aCatalog = await within(a.container).findByRole("switch", { name: "Enable Catalog integration" });
    const bCredentials = await within(b.container).findByRole("switch", { name: "Enable Credentials integration" });
    fireEvent.click(bCredentials);
    await waitFor(() => expect(bCredentials.getAttribute("aria-checked")).toBe("false"));
    expect(aCredentials.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(aCatalog);
    await waitFor(() => expect(aCatalog.getAttribute("aria-checked")).toBe("false"));
    expect(await state.read()).toEqual({ projectEnvironments: false, catalog: false, agents: true, projects: true });
  } finally { await host.harness.dispose(); }
});

it("removes stale retry eligibility when the real observer re-reads an expired source job", async () => {
  const thread = makeThreadResponse({ id: "preparation-thread", environmentId: "preparation-environment" });
  const jobId = "33333333-3333-4333-8333-333333333333";
  let phase = "retryable";
  let starts = 0;
  const jobRequest = z.object({ jobId: z.string().uuid() });
  const host = createFakePluginHost({ pluginId: "sandboxes", sdk: {
    threads: { get: async () => thread },
    environments: { get: async () => ({ id: thread.environmentId!, projectId: "project", hostId: "host", path: "/fixture/workspace", status: "ready" }) },
    hosts: { get: async () => makeHostResponse({ id: "host", name: "Fixture", machineProviderId: "sandbox-daytona" }) },
    plugins: { callRpc: async ({ method, input, outputSchema }) => {
      let result: unknown;
      if (method === "startPrepare") { starts++; result = { jobId }; }
      else {
        const request = jobRequest.parse(input);
        result = phase === "retryable"
          ? { schemaVersion: 1, jobId: request.jobId, state: "complete", ready: false, retryable: true, reason: "not_ready" }
          : { schemaVersion: 1, jobId: request.jobId, state: "unknown", retryable: false, reason: phase === "expired" ? "job_unavailable" : "completion_unconfirmed" };
      }
      return outputSchema instanceof z.ZodType ? outputSchema.parse(result) : result;
    } },
  } });
  try {
    const observer = registerNativeProjectEnvironmentSync(host.bb, { isPluginRunning: async () => true, pollMs: 1 });
    await host.harness.behavior.emitThreadEvent("thread.active", { thread });
    await waitFor(async () => expect((await observer.status(thread.id)).state).toBe("not-ready"));
    const slot = renderSlot({ component: SandboxPreparationStatus }, { threadId: thread.id }, { rpc: {
      projectPreparationStatus: () => observer.status(thread.id),
      reconcileProjectPreparation: () => observer.reconcile(thread.id),
      retryProjectPreparation: () => observer.retry(thread.id),
    } as never });
    const retry = await slot.findByRole("button", { name: "Retry preparation" });
    phase = "expired";
    fireEvent.click(retry);
    await waitFor(() => expect(slot.queryByRole("button", { name: "Retry preparation" })).toBeNull());
    expect(slot.getByRole("button", { name: "Refresh job status" })).toBeTruthy();
    expect(starts).toBe(1);
  } finally { await host.harness.dispose(); }
});
