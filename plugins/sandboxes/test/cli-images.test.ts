import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  registerSandboxCli,
  type SandboxCliDeps,
} from "../src/cli.js";
import type { SandboxRuntimeConfig } from "../src/config.js";
import type {
  SandboxImageBuild,
  SandboxImageJobStatus,
} from "../src/image-manager.js";
import { SandboxManager } from "../src/manager.js";
import { sandboxMigrations, SandboxStore } from "../src/store.js";

const digest = `sha256:${"c".repeat(64)}`;

function runtimeConfig(): SandboxRuntimeConfig {
  return {
    daytona: null,
    modal: null,
    e2b: null,
    box: null,
    freestyle: null,
    nirvana: null,
    idleSleepMs: null,
    defaultSizeTier: "M",
    copyGitHubCliAuth: false,
    sandboxEnv: {},
    image: {
      repository: "ghcr.io/acme/bb-sandbox",
      username: null,
      token: null,
      platform: "linux/amd64",
    },
  };
}

function build(
  registrations: SandboxImageBuild["registrations"],
): SandboxImageBuild {
  return {
    version: "v1",
    reference: "ghcr.io/acme/bb-sandbox:v1",
    digest,
    pinnedReference: `ghcr.io/acme/bb-sandbox@${digest}`,
    extraPackages: [],
    registrations,
  };
}

function settled(
  kind: "build" | "register",
  result: SandboxImageBuild,
): SandboxImageJobStatus {
  return {
    id: "job_1",
    kind,
    version: result.version,
    reference: result.reference,
    pinnedReference: result.pinnedReference,
    imageIds: [],
    state: result.registrations.some(
      (registration) => registration.status === "error",
    )
      ? "error"
      : "ready",
    error: null,
    progress: [],
    cursor: 0,
    images: [],
    build: result,
  };
}

async function cli(
  status: SandboxImageJobStatus,
  overrides: SandboxCliDeps = {},
) {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const db = fake.bb.storage.database();
  fake.bb.storage.migrate(db, [...sandboxMigrations]);
  const store = new SandboxStore(db);
  const manager = new SandboxManager(fake.bb, store, {
    config: runtimeConfig(),
  });
  const requests: Array<{ provider?: string; name?: string }> = [];
  registerSandboxCli(fake.bb, manager, {
    buildImage: async (request) => {
      requests.push(request);
      return {
        id: status.id,
        kind: "build",
        version: status.version,
        reference: status.reference,
        pinnedReference: null,
        imageIds: [],
      };
    },
    imageJob: () => status,
    ...overrides,
  });
  return { fake, requests };
}

describe("bb sandbox capacity", () => {
  it("prints live region and class quotas in JSON and text", async () => {
    const capacity = {
      organizationId: "org-1",
      refreshedAt: 1,
      pools: [
        {
          regionId: "us-west-3",
          regionName: "US West 3",
          regionType: "shared",
          sandboxClass: "linux-vm" as const,
          totalCpu: 160,
          usedCpu: 16,
          totalMemoryGiB: 320,
          usedMemoryGiB: 32,
          totalDiskGiB: 1000,
          usedDiskGiB: 100,
          maxCpuPerSandbox: 16,
          maxMemoryGiBPerSandbox: 32,
          maxDiskGiBPerSandbox: 100,
          maxLifespanMinutes: null,
        },
      ],
    };
    const status = settled("build", build([]));
    const { fake } = await cli(status, {
      daytonaCapacity: async () => capacity,
    });

    const text = await fake.harness.runCli(["capacity"]);
    const structured = await fake.harness.runCli(["capacity", "--json"]);

    expect(text.stdout).toContain(
      "us-west-3\tlinux-vm\t16/160 CPU\t32/320 GiB RAM\t100/1000 GiB disk\tmax 16 CPU/32 GiB/100 GiB",
    );
    expect(JSON.parse(structured.stdout ?? "")).toEqual({ capacity });
    await fake.harness.dispose();
  });
});
describe("bb sandbox doctor capacity audits", () => {
  it("fails when placement, quota, or provider access is unsafe", async () => {
    const { fake } = await cli(settled("build", build([])), {
      capacityDoctor: async () => [
        {
          severity: "error",
          code: "image-placement-mismatch",
          message: "active snapshot belongs to another pool",
        },
      ],
    });

    const result = await fake.harness.runCli(["doctor", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout ?? "").capacityFindings).toEqual([
      {
        severity: "error",
        code: "image-placement-mismatch",
        message: "active snapshot belongs to another pool",
      },
    ]);
    await fake.harness.dispose();
  });
});


describe("bb sandbox build-image", () => {
  it("builds once for the whole fleet and reports every registration", async () => {
    const { fake, requests } = await cli(
      settled(
        "build",
        build([
          {
            provider: "daytona",
            sizeTier: null,
            status: "registered",
            name: "bb-sandbox-v1",
            imageId: "img_1",
            message: null,
          },
          {
            provider: "modal",
            sizeTier: null,
            status: "skipped",
            name: null,
            imageId: null,
            message: "modal has no credentials configured",
          },
        ]),
      ),
    );

    const result = await fake.harness.runCli(["build-image", "--local", "--json"]);

    expect(requests).toEqual([{}]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "").job.build).toMatchObject({
      pinnedReference: `ghcr.io/acme/bb-sandbox@${digest}`,
      registrations: [
        { provider: "daytona", status: "registered", name: "bb-sandbox-v1" },
        { provider: "modal", status: "skipped" },
      ],
    });
    await fake.harness.dispose();
  });

  it("targets one provider and fails the command when it errors", async () => {
    const { fake, requests } = await cli(
      settled(
        "build",
        build([
          {
            provider: "e2b",
            sizeTier: null,
            status: "error",
            name: null,
            imageId: "img_2",
            message: "e2b rejected the template",
          },
        ]),
      ),
    );

    const result = await fake.harness.runCli([
      "build-image",
      "--local",
      "--provider",
      "e2b",
      "--name",
      "v1",
    ]);

    expect(requests).toEqual([{ provider: "e2b", name: "v1" }]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`Pushed ghcr.io/acme/bb-sandbox@${digest}`);
    expect(result.stdout).toContain("e2b\terror\te2b rejected the template");
    await fake.harness.dispose();
  });

  it("refuses providers that have no custom-image API", async () => {
    const { fake } = await cli(settled("build", build([])));

    await expect(
      fake.harness.runCli(["build-image", "--local", "--provider", "box"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining(
        "--provider must be one of daytona, modal, e2b, nirvana",
      ),
    });
    await fake.harness.dispose();
  });

  it("points at CI unless the local fallback is asked for explicitly", async () => {
    const { fake, requests } = await cli(settled("build", build([])));

    await expect(fake.harness.runCli(["build-image"])).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("bb sandbox register-image"),
    });
    expect(requests).toEqual([]);
    await fake.harness.dispose();
  });
});


describe("retired image selection", () => {
  it.each(["activate-image", "project-images", "set-project-image", "clear-project-image", "set-image-version"])("does not expose %s or start an image job", async (command) => {
    const { fake, requests } = await cli(settled("build", build([])));
    const result = await fake.harness.runCli([command, "old-image", "--provider", "modal", "--project", "project-1"]);
    expect(result.exitCode).not.toBe(0);
    expect(requests).toEqual([]);
    await fake.harness.dispose();
  });
});
