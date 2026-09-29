import fs from "node:fs/promises";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctorReport, runGatewayDoctor } from "./gateway-doctor.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("runGatewayDoctor", () => {
  it("reports Account Pooler blocking and per-host provider plan labels", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-gateway-doctor-"));
    const host = createFakePluginHost({
      pluginId: "model-gateway",
      dataDir,
      sdk: {
        plugins: {
          list: async () => ({
            plugins: [{ id: "account-pool", enabled: true }],
          }),
        },
        hosts: { list: async () => [{ id: "host-one", name: "One" }] },
        system: {
          providerStates: async () => ({
            providers: [
              { providerId: "claude-code", status: "ready", planLabel: "Proxied" },
              {
                providerId: "codex",
                status: "unauthenticated",
                planLabel: null,
              },
            ],
          }),
        },
      },
    });
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const report = await runGatewayDoctor(host.bb);
    expect(report).toEqual({
      accountPoolInstalledAndEnabled: true,
      hosts: [
        {
          hostId: "host-one",
          hostName: "One",
          claudeCodePlanLabel: "Proxied",
          codexPlanLabel: null,
        },
      ],
    });
    const formatted = formatDoctorReport(report);
    expect(formatted).toContain("Account Pooler installed and enabled: true");
    expect(formatted).toContain("One\tclaude-code=Proxied\tcodex=-");
  });

  it("reports the Account Pooler as not blocking when it is not installed", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-gateway-doctor-"));
    const host = createFakePluginHost({
      pluginId: "model-gateway",
      dataDir,
      sdk: {
        plugins: { list: async () => ({ plugins: [] }) },
        hosts: { list: async () => [] },
        system: { providerStates: async () => ({ providers: [] }) },
      },
    });
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const report = await runGatewayDoctor(host.bb);
    expect(report).toEqual({
      accountPoolInstalledAndEnabled: false,
      hosts: [],
    });
    expect(formatDoctorReport(report)).toContain("No enrolled hosts.");
  });
});
