import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { sandboxMigrations, SandboxStore } from "../src/store.js";
import type { SandboxImageRecord, SandboxRecord } from "../src/store.js";
import { auditVersions, versionState } from "../src/version-audit.js";

function image(overrides: Partial<SandboxImageRecord>): SandboxImageRecord {
  return {
    id: "img_1",
    provider: "daytona",
    name: "bb-sandbox-current",
    status: "ready",
    isDefault: true,
    extraPackages: [],
    error: null,
    regionId: null,
    sandboxClass: null,
    bbAppVersion: "0.42.0",
    sizeTier: null,
    imageVersion: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function sandbox(overrides: Partial<SandboxRecord>): SandboxRecord {
  return {
    id: "sbx_1",
    provider: "daytona",
    providerSandboxId: "daytona-1",
    projectId: "proj_1",
    projectName: "monorepo",
    hostId: "host_1",
    connectMachineId: null,
    projectSourceId: null,
    workspacePath: "/root/.bb/checkouts/monorepo",
    credentialProfileId: null,
    usesProjectDefaultCredential: true,
    threadId: "thr_1",
    status: "ready",
    error: null,
    bbAppVersion: "0.42.0",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("version audit", () => {
  it("compares recorded versions with the server", () => {
    expect(versionState("0.42.0", "0.42.0")).toBe("current");
    expect(versionState("0.40.0", "0.42.0")).toBe("behind");
    expect(versionState(null, "0.42.0")).toBe("unknown");
  });

  it("reports nothing when images, pins, and machines match the server", () => {
    const audit = auditVersions({
      serverVersion: "0.42.0",
      previousServerVersion: null,
      defaultImages: [image({})],
      pins: [],
      sandboxes: [
        {
          record: sandbox({}),
          busy: false,
          upgradeable: true,
          upgradePending: false,
          rejectedProtocol: null,
        },
      ],
    });
    expect(audit.findings).toEqual([]);
    expect(audit.images[0]?.state).toBe("current");
    expect(audit.sandboxes[0]?.state).toBe("current");
  });

  it("names the stale pin and the command that clears it", () => {
    const audit = auditVersions({
      serverVersion: "0.42.0",
      previousServerVersion: "0.40.0",
      defaultImages: [image({})],
      pins: [
        {
          projectId: "proj_monorepo",
          provider: "daytona",
          imageId: "img_old",
          imageName: "bb-sandbox-20260820t044750z-west3-vm30",
          updatedAt: 3,
          bbAppVersion: "0.38.0",
        },
      ],
      sandboxes: [],
    });
    expect(audit.findings).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "pin-behind",
        projectId: "proj_monorepo",
        fix: "bb sandbox clear-project-image --provider daytona --project proj_monorepo",
      }),
    ]);
    expect(audit.previousServerVersion).toBe("0.40.0");
  });

  it("distinguishes idle, busy, queued, unsupported, and rejected machines", () => {
    const audit = auditVersions({
      serverVersion: "0.42.0",
      previousServerVersion: null,
      defaultImages: [image({ bbAppVersion: "0.40.0" }), image({ id: "img_e2b", provider: "e2b", bbAppVersion: null })],
      pins: [],
      sandboxes: [
        {
          record: sandbox({ id: "sbx_idle", bbAppVersion: "0.40.0" }),
          busy: false,
          upgradeable: true,
          upgradePending: false,
          rejectedProtocol: null,
        },
        {
          record: sandbox({ id: "sbx_busy", bbAppVersion: "0.40.0" }),
          busy: true,
          upgradeable: true,
          upgradePending: false,
          rejectedProtocol: null,
        },
        {
          record: sandbox({ id: "sbx_queued", bbAppVersion: "0.40.0" }),
          busy: true,
          upgradeable: true,
          upgradePending: true,
          rejectedProtocol: null,
        },
        {
          record: sandbox({ id: "sbx_modal", provider: "modal", bbAppVersion: "0.40.0" }),
          busy: false,
          upgradeable: false,
          upgradePending: false,
          rejectedProtocol: null,
        },
        {
          record: sandbox({ id: "sbx_rejected", bbAppVersion: "0.42.0" }),
          busy: false,
          upgradeable: true,
          upgradePending: false,
          rejectedProtocol: 123,
        },
        {
          record: sandbox({ id: "sbx_unknown", bbAppVersion: null }),
          busy: false,
          upgradeable: true,
          upgradePending: false,
          rejectedProtocol: null,
        },
      ],
    });
    const byCode = Object.fromEntries(
      audit.findings.map((finding) => [
        `${finding.code}:${finding.sandboxId ?? finding.provider}`,
        finding,
      ]),
    );
    expect(byCode["image-behind:daytona"]).toMatchObject({
      severity: "error",
      fix: "bb sandbox build-image --provider daytona",
    });
    expect(byCode["image-version-unknown:e2b"]).toMatchObject({ severity: "warning" });
    expect(byCode["sandbox-behind:sbx_idle"]).toMatchObject({
      severity: "error",
      fix: "bb sandbox upgrade sbx_idle",
    });
    expect(byCode["sandbox-behind-busy:sbx_busy"]).toMatchObject({
      severity: "warning",
      fix: "bb sandbox upgrade --all",
    });
    expect(byCode["sandbox-behind-busy:sbx_queued"]).toMatchObject({
      severity: "warning",
      fix: null,
    });
    expect(byCode["sandbox-not-upgradeable:sbx_modal"]).toMatchObject({
      severity: "error",
      fix: "bb sandbox delete sbx_modal --yes",
    });
    expect(byCode["sandbox-rejected:sbx_rejected"]).toMatchObject({
      severity: "error",
      message: expect.stringContaining("protocol 123"),
      fix: "bb sandbox upgrade sbx_rejected",
    });
    expect(byCode["sandbox-version-unknown:sbx_unknown"]).toMatchObject({
      severity: "warning",
    });
    expect(audit.findings).toHaveLength(8);
  });
});

describe("version storage", () => {
  it("records bb-app versions on images", async () => {
    const fake = createFakePluginHost({ pluginId: "sandboxes" });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);

    const built = store.beginImageBuild({
      id: "img_built",
      provider: "daytona",
      name: "bb-sandbox-built",
      extraPackages: [],
      bbAppVersion: "0.42.0",
    });
    expect(built.bbAppVersion).toBe("0.42.0");
    const registered = store.beginImageBuild({
      id: "img_registered",
      provider: "daytona",
      name: "bb-sandbox-registered",
      extraPackages: [],
    });
    expect(registered.bbAppVersion).toBeNull();
    expect(store.setImageBbAppVersion(registered.id, "0.42.1").bbAppVersion).toBe(
      "0.42.1",
    );
    // Re-registering the same name without a version keeps the known one.
    expect(
      store.beginImageBuild({
        id: "img_registered_again",
        provider: "daytona",
        name: "bb-sandbox-registered",
        extraPackages: [],
      }).bbAppVersion,
    ).toBe("0.42.1");
    await fake.harness.dispose();
  });
});
