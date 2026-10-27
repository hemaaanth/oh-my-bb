import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { syntheticBrowserArtifact, writeBrowserArtifactFixture } from "./browser-artifact-fixture.js";
import type { SandboxProvider } from "../src/backend.js";
import type { BuildAndPushSandboxImageInput } from "../src/build-image.js";
import type { SandboxSettings } from "../src/config.js";
import { sandboxImageContextFiles } from "../src/image-catalog.js";
import {
  SandboxImageManager,
  type SandboxImageManagerDeps,
} from "../src/image-manager.js";
import type { SandboxImageRegistrationRequest } from "../src/register-image.js";
import { sandboxMigrations, SandboxStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dockerContext(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-image-docker-"));
  temporaryDirectories.push(directory);
  for (const filename of sandboxImageContextFiles) {
    await writeFile(join(directory, filename), filename);
  }
  await writeFile(
    join(directory, "Dockerfile"),
    "FROM node:22-bookworm-slim\n# bb:extra-packages\n",
  );
  await writeBrowserArtifactFixture(directory);
  return join(directory, "Dockerfile");
}

function settings(overrides: Partial<SandboxSettings> = {}): SandboxSettings {
  return {
    sshEnabled: false,
    sshAuthKey: "",
    sshApiKey: "",
    daytonaApiKey: "",
    daytonaApiUrl: "",
    daytonaTarget: "",
    daytonaSandboxClass: "container",
    daytonaSnapshot: "",
    modalTokenId: "",
    modalTokenSecret: "",
    modalApp: "bb-sandboxes",
    modalImageName: "",
    modalVmRuntime: false,
    e2bApiKey: "",
    e2bTemplate: "",
    boxApiKey: "",
    boxMachineClass: "default",
    boxEnvironment: "base",
    freestyleApiKey: "",
    freestyleCpu: "4",
    freestyleMemory: "8",
    freestyleStorage: "20",
    freestylePersistence: "sticky",
    freestyleSnapshotId: "",
    nirvanaApiKey: "",
    nirvanaApiEndpoint: "",
    nirvanaGatewayEndpoint: "",
    nirvanaImageUri: "",
    nirvanaCpu: "4",
    nirvanaMemory: "8Gi",
    nirvanaStorage: "50Gi",
    idleSleepAfter: "15 minutes",
    defaultSizeTier: "M",
    copyGitHubCliAuth: true,
    gitUsername: "",
    gitToken: "",
    gitSshPrivateKey: "",
    gitKnownHosts: "",
    browserUserAgent: "",
    browserExitNode: "",
    browserHomeEgressIp: "",
    browserTailscaleAuthKey: "",
    browserTailscaleAuthKeyFile: "",
    browserStateFile: "",
    imageRegistry: "ghcr.io/acme/bb-sandbox",
    imageRegistryUsername: "",
    imageRegistryToken: "",
    imagePlatform: "",
    ...overrides,
  };
}

const digest = `sha256:${"a".repeat(64)}`;

async function harness(
  overrides: {
    settings?: Partial<SandboxSettings>;
    register?: SandboxImageManagerDeps["register"];
    buildAndPush?: SandboxImageManagerDeps["buildAndPush"];
    resolveRegistryImage?: SandboxImageManagerDeps["resolveRegistryImage"];
    daytonaPool?: SandboxImageManagerDeps["daytonaPool"];
  } = {},
) {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const db = fake.bb.storage.database();
  fake.bb.storage.migrate(db, [...sandboxMigrations]);
  const store = new SandboxStore(db);
  const builds: BuildAndPushSandboxImageInput[] = [];
  const registrations: SandboxImageRegistrationRequest[] = [];
  const activations: Array<{ provider: SandboxProvider; name: string }> = [];
  const manager = new SandboxImageManager({
    bb: fake.bb,
    store,
    verifyBrowserImage: async () => syntheticBrowserArtifact,
    getSettings: async () => settings(overrides.settings),
    dockerfilePath: await dockerContext(),
    bbAppVersion: async () => "0.38.0",
    buildAndPush:
      overrides.buildAndPush ??
      (async (input) => {
        builds.push(input);
        return {
          reference: input.reference,
          digest,
          pinnedReference: `ghcr.io/acme/bb-sandbox@${digest}`,
        };
      }),
    register:
      overrides.register ??
      (async (input) => {
        registrations.push(input);
        return { name: input.name, placement: null };
      }),
    resolveRegistryImage:
      overrides.resolveRegistryImage ??
      (async ({ registry, reference }) => {
        const tag = reference ?? "20260820t031500z";
        return {
          repository: registry.repository,
          tag,
          digest,
          reference: `${registry.repository}:${tag}`,
          pinnedReference: `${registry.repository}@${digest}`,
        };
      }),
    activateImage: async (provider, name) => {
      activations.push({ provider, name });
    },
    ...(overrides.daytonaPool === undefined ? {} : { daytonaPool: overrides.daytonaPool }),
  });
  return { fake, store, manager, builds, registrations, activations };
}

const allCredentials = {
  daytonaApiKey: "d",
  modalTokenId: "m",
  modalTokenSecret: "s",
  e2bApiKey: "e",
  nirvanaApiKey: "n",
  nirvanaApiEndpoint: "https://api.example.com",
  nirvanaGatewayEndpoint: "https://gateway.example.com",
};

describe("SandboxImageManager", () => {
  it("builds one image and registers it with every credentialed provider", async () => {
    const { fake, store, manager, builds, registrations, activations } =
      await harness({ settings: allCredentials });
    store.updateProviderSettings("e2b", { extraPackages: ["imagemagick"] });

    const build = await manager.build({ name: "v1" });

    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      reference: "ghcr.io/acme/bb-sandbox:v1",
      platform: "linux/amd64",
      bbAppVersion: "0.38.0",
    });
    expect(build.pinnedReference).toBe(`ghcr.io/acme/bb-sandbox@${digest}`);
    expect(build.extraPackages).toEqual(["imagemagick"]);
    expect(
      registrations.map(({ provider, name, pinnedReference }) => ({
        provider,
        name,
        pinnedReference,
      })),
    ).toEqual([
      // Daytona sizes a sandbox by its snapshot, so one image push registers
      // every size the pool can host; nothing here limits the pool.
      ...["s", "m", "l", "xl"].map((tier) => ({
        provider: "daytona",
        name: `bb-sandbox-v1-${tier}`,
        pinnedReference: `ghcr.io/acme/bb-sandbox@${digest}`,
      })),
      {
        provider: "modal",
        name: "bb-sandbox:v1",
        pinnedReference: `ghcr.io/acme/bb-sandbox@${digest}`,
      },
      {
        provider: "e2b",
        name: "bb-sandbox-v1",
        pinnedReference: `ghcr.io/acme/bb-sandbox@${digest}`,
      },
      {
        provider: "nirvana",
        name: `ghcr.io/acme/bb-sandbox@${digest}`,
        pinnedReference: `ghcr.io/acme/bb-sandbox@${digest}`,
      },
    ]);
    expect(activations).toEqual(
      registrations.map(({ provider, name }) => ({ provider, name })),
    );
    expect(build.registrations.map(({ status }) => status)).toEqual(
      new Array(7).fill("registered"),
    );
    expect(store.getDefaultImage("daytona")?.name).toBe("bb-sandbox-v1-m");
    expect(store.getDefaultImage("daytona", "XL")).toMatchObject({
      name: "bb-sandbox-v1-xl",
      sizeTier: "XL",
      imageVersion: "v1",
      isDefault: true,
    });
    expect(store.getDefaultImage("nirvana")?.status).toBe("ready");
    await fake.harness.dispose();
  });

  it("registers only the sizes the Daytona pool can host, one active image per size", async () => {
    const { fake, store, manager, registrations } = await harness({
      settings: { daytonaApiKey: "d", daytonaTarget: "us", daytonaSandboxClass: "container" },
      daytonaPool: async () => ({
        placement: { regionId: "us", sandboxClass: "container" },
        pool: {
          regionId: "us",
          regionName: "us",
          regionType: "shared",
          sandboxClass: "container",
          totalCpu: 250,
          usedCpu: 0,
          totalMemoryGiB: 500,
          usedMemoryGiB: 0,
          totalDiskGiB: 2000,
          usedDiskGiB: 0,
          maxCpuPerSandbox: null,
          maxMemoryGiBPerSandbox: 12,
          maxDiskGiBPerSandbox: 20,
          maxLifespanMinutes: null,
        },
      }),
    });

    const first = await manager.build({ name: "v1", provider: "daytona" });
    expect(
      registrations.map(({ name, sizeTier }) => `${name}:${sizeTier}`),
    ).toEqual(["bb-sandbox-v1-s:S", "bb-sandbox-v1-m:M"]);
    expect(first.registrations.map(({ sizeTier, status }) => `${sizeTier}:${status}`))
      .toEqual(["S:registered", "M:registered"]);
    expect(store.getDefaultImage("daytona", "L")).toBeNull();

    // A new build retires the previous active image of the same size only.
    await manager.build({ name: "v2", provider: "daytona" });
    expect(store.getDefaultImage("daytona", "S")?.name).toBe("bb-sandbox-v2-s");
    expect(store.getDefaultImage("daytona", "M")?.name).toBe("bb-sandbox-v2-m");
    expect(store.listImages("daytona").filter((image) => image.isDefault)).toHaveLength(2);

    // Asking for a size the pool cannot host fails rather than silently registering nothing.
    await expect(manager.build({ name: "v3", provider: "daytona", sizeTier: "XL" })).rejects.toThrow(
      "cannot host any of the requested sizes",
    );
    await fake.harness.dispose();
  });

  it("persists the Daytona region and class returned by snapshot registration", async () => {
    const { fake, store, manager } = await harness({
      settings: {
        daytonaApiKey: "d",
        daytonaTarget: "us-west-3",
        daytonaSandboxClass: "linux-vm",
      },
      register: async (input) => ({
        name: input.name,
        placement:
          input.provider === "daytona"
            ? { regionId: "us-west-3", sandboxClass: "linux-vm" }
            : null,
      }),
    });

    await manager.build({ provider: "daytona", name: "west3" });

    expect(store.getDefaultImage("daytona")).toMatchObject({
      name: "bb-sandbox-west3-m",
      regionId: "us-west-3",
      sandboxClass: "linux-vm",
    });
    await fake.harness.dispose();
  });

  it("skips providers without credentials", async () => {
    const { fake, manager, builds } = await harness({
      settings: { e2bApiKey: "e" },
    });

    const build = await manager.build({});

    expect(builds).toHaveLength(1);
    expect(
      build.registrations.map(({ provider, status }) => `${provider}:${status}`),
    ).toEqual([
      "daytona:skipped",
      "modal:skipped",
      "e2b:registered",
      "nirvana:skipped",
    ]);
    await fake.harness.dispose();
  });

  it("refuses to build without an image repository", async () => {
    const { fake, manager, builds } = await harness({
      settings: { ...allCredentials, imageRegistry: "" },
    });

    await expect(manager.build({})).rejects.toThrow(
      "Set the sandbox image repository",
    );
    expect(builds).toEqual([]);
    await fake.harness.dispose();
  });

  it("refuses providers that bootstrap at launch", async () => {
    const { fake, manager } = await harness({ settings: allCredentials });

    await expect(manager.build({ provider: "box" })).rejects.toThrow(
      "bootstraps its toolchain at launch",
    );
    await fake.harness.dispose();
  });

  it("records a failed registration without losing the other providers", async () => {
    const { fake, store, manager } = await harness({
      settings: allCredentials,
      register: async (input) => {
        if (input.provider === "modal") throw new Error("modal is down");
        return { name: input.name, placement: null };
      },
    });

    const build = await manager.build({ name: "v2" });

    expect(
      build.registrations.map(({ provider, status }) => `${provider}:${status}`),
    ).toEqual([
      "daytona:registered",
      "daytona:registered",
      "daytona:registered",
      "daytona:registered",
      "modal:error",
      "e2b:registered",
      "nirvana:registered",
    ]);
    expect(store.listImages("modal")[0]).toMatchObject({
      status: "error",
      error: "modal is down",
      isDefault: false,
    });
    expect(store.getDefaultImage("e2b")?.name).toBe("bb-sandbox-v2");
    await fake.harness.dispose();
  });

  it("surfaces a failure when one provider was requested explicitly", async () => {
    const { fake, manager, builds } = await harness({
      settings: allCredentials,
      register: async () => {
        throw new Error("daytona rejected the snapshot");
      },
    });

    await expect(manager.build({ provider: "daytona" })).rejects.toThrow(
      "daytona rejected the snapshot",
    );
    expect(builds).toHaveLength(1);
    await fake.harness.dispose();
  });

  it("collapses concurrent fleet builds into one image", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fake, manager, builds } = await harness({
      settings: allCredentials,
      buildAndPush: async (input) => {
        await gate;
        builds.push(input);
        return {
          reference: input.reference,
          digest,
          pinnedReference: `ghcr.io/acme/bb-sandbox@${digest}`,
        };
      },
    });

    const first = manager.build({ name: "v3" });
    const second = manager.build({ name: "v4" });
    release?.();
    const [left, right] = await Promise.all([first, second]);

    expect(builds).toHaveLength(1);
    expect(left.version).toBe("v3");
    expect(right).toBe(left);
    await fake.harness.dispose();
  });

  it("rejects version names that providers cannot accept", async () => {
    const { fake, manager } = await harness({ settings: allCredentials });

    await expect(manager.build({ name: "Bad Version" })).rejects.toThrow(
      "lowercase letters, numbers, and dashes",
    );
    await fake.harness.dispose();
  });
});
