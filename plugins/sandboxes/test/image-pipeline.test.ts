import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syntheticBrowserArtifact, writeBrowserArtifactFixture } from "./browser-artifact-fixture.js";
import { registerSandboxCli } from "../src/cli.js";
import type { SandboxRuntimeConfig, SandboxSettings } from "../src/config.js";
import { sandboxImageContextFiles } from "../src/image-catalog.js";
import {
  SandboxImageManager,
  type SandboxImageJobStatus,
} from "../src/image-manager.js";
import { SandboxManager } from "../src/manager.js";
import {
  newestImageVersionTag,
  resolveRegistryImage,
  type SandboxImageRegistrationRequest,
  type SandboxImageRegistrationResult,
} from "../src/register-image.js";
import { sandboxMigrations, SandboxStore } from "../src/store.js";

const temporaryDirectories: string[] = [];
const digest = `sha256:${"b".repeat(64)}`;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dockerContext(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-image-pipeline-"));
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
    daytonaApiKey: "d",
    daytonaApiUrl: "",
    daytonaTarget: "",
    daytonaSandboxClass: "container",
    daytonaSnapshot: "",
    modalTokenId: "m",
    modalTokenSecret: "s",
    modalApp: "bb-sandboxes",
    modalImageName: "",
    modalVmRuntime: false,
    e2bApiKey: "e",
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
    imageRegistry: "ghcr.io/fixture-owner/sandbox-image",
    imageRegistryUsername: "fixture-owner",
    imageRegistryToken: "synthetic-registry-token",
    imagePlatform: "",
    ...overrides,
  };
}

async function registrationHarness(
  register?: (
    input: SandboxImageRegistrationRequest,
    store: SandboxStore,
  ) => Promise<SandboxImageRegistrationResult>,
) {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const db = fake.bb.storage.database();
  fake.bb.storage.migrate(db, [...sandboxMigrations]);
  const store = new SandboxStore(db);
  const registrations: SandboxImageRegistrationRequest[] = [];
  const manager = new SandboxImageManager({
    bb: fake.bb,
    store,
    verifyBrowserImage: async () => syntheticBrowserArtifact,
    getSettings: async () => settings(),
    dockerfilePath: await dockerContext(),
    bbAppVersion: async () => "0.38.0",
    buildAndPush: async () => {
      throw new Error("registration must never run a local Docker build");
    },
    register: async (input) => {
      if (register !== undefined) return register(input, store);
      registrations.push(input);
      return { name: input.name, placement: null };
    },
    resolveRegistryImage: async ({ registry, reference }) => {
      const tag = reference ?? "20260820t031500z";
      return {
        repository: registry.repository,
        tag,
        digest,
        reference: `${registry.repository}:${tag}`,
        pinnedReference: `${registry.repository}@${digest}`,
      };
    },
    activateImage: async () => undefined,
  });
  return { fake, store, manager, registrations };
}

/**
 * The job runs on the background promise chain the CLI polls. Every dependency
 * here settles immediately, so yielding the event loop — rather than waiting a
 * guessed duration — is enough to let it finish.
 */
async function untilSettled(
  manager: SandboxImageManager,
  jobId: string,
): Promise<SandboxImageJobStatus> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = manager.job(jobId);
    if (status.state !== "running") return status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Sandbox image job ${jobId} never settled`);
}

describe("newestImageVersionTag", () => {
  it("picks the newest generated timestamp and ignores moving tags", () => {
    expect(
      newestImageVersionTag([
        "latest",
        "20260819t201500z",
        "main",
        "20260820t031500z",
        "20260101t000000z",
        "v2",
        "sha-abc1234",
      ]),
    ).toBe("20260820t031500z");
  });

  it("has no candidate when the registry holds only moving tags", () => {
    expect(newestImageVersionTag(["latest", "main"])).toBeNull();
  });
});

describe("resolveRegistryImage", () => {
  it("exchanges the stored token, takes the newest tag, and pins the digest", async () => {
    const calls: string[] = [];
    const authorizations: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = input.toString();
        calls.push(url);
        const headers = new Headers(init?.headers);
        authorizations.push(headers.get("authorization"));
        if (url.startsWith("https://ghcr.io/token")) {
          return new Response(JSON.stringify({ token: "scoped-token" }), {
            status: 200,
          });
        }
        if (headers.get("authorization") === null) {
          return new Response("", {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:fixture-owner/sandbox-image:pull"',
            },
          });
        }
        if (url.endsWith("/tags/list?n=1000")) {
          return new Response(
            JSON.stringify({
              name: "fixture-owner/sandbox-image",
              tags: ["latest", "20260819t201500z", "20260820t031500z"],
            }),
            { status: 200 },
          );
        }
        return new Response("{}", {
          status: 200,
          headers: { "docker-content-digest": digest },
        });
      },
    );

    const resolved = await resolveRegistryImage({
      registry: {
        repository: "ghcr.io/fixture-owner/sandbox-image",
        username: "fixture-owner",
        token: "synthetic-registry-token",
        platform: "linux/amd64",
      },
      reference: null,
    });

    expect(resolved).toEqual({
      repository: "ghcr.io/fixture-owner/sandbox-image",
      tag: "20260820t031500z",
      digest,
      reference: "ghcr.io/fixture-owner/sandbox-image:20260820t031500z",
      pinnedReference: `ghcr.io/fixture-owner/sandbox-image@${digest}`,
    });
    expect(calls).toContain(
      "https://ghcr.io/v2/fixture-owner/sandbox-image/manifests/20260820t031500z",
    );
    expect(
      calls.some((url) =>
        url.startsWith(
          "https://ghcr.io/token?service=ghcr.io&scope=repository%3Afixture-owner",
        ),
      ),
    ).toBe(true);
    expect(authorizations).toContain(
      `Basic ${Buffer.from("fixture-owner:synthetic-registry-token").toString("base64")}`,
    );
  });

  it("refuses a digest reference because Daytona pins by tag", async () => {
    await expect(
      resolveRegistryImage({
        registry: {
          repository: "ghcr.io/fixture-owner/sandbox-image",
          username: null,
          token: null,
          platform: "linux/amd64",
        },
        reference: `ghcr.io/fixture-owner/sandbox-image@${digest}`,
      }),
    ).rejects.toThrow("Pass the image tag rather than a digest");
  });
});

describe("bb sandbox register-image", () => {
  it("records an image row and pins every provider to the right reference form", async () => {
    const { fake, store, manager, registrations } = await registrationHarness();

    const handle = await manager.startRegistration({});
    const status = await untilSettled(manager, handle.id);

    expect(status.state).toBe("ready");
    expect(handle.version).toBe("20260820t031500z");
    expect(
      registrations.map(({ provider, reference, pinnedReference }) => ({
        provider,
        reference,
        pinnedReference,
      })),
    ).toEqual([
      ...new Array(4).fill({
        provider: "daytona",
        reference: "ghcr.io/fixture-owner/sandbox-image:20260820t031500z",
        pinnedReference: `ghcr.io/fixture-owner/sandbox-image@${digest}`,
      }),
      {
        provider: "modal",
        reference: "ghcr.io/fixture-owner/sandbox-image:20260820t031500z",
        pinnedReference: `ghcr.io/fixture-owner/sandbox-image@${digest}`,
      },
      {
        provider: "e2b",
        reference: "ghcr.io/fixture-owner/sandbox-image:20260820t031500z",
        pinnedReference: `ghcr.io/fixture-owner/sandbox-image@${digest}`,
      },
    ]);
    // Daytona runs once per size.
    expect(status.build?.registrations.map((entry) => entry.status)).toEqual([
      ...new Array(6).fill("registered"),
    ]);
    expect(store.getDefaultImage("daytona")).toMatchObject({
      name: "bb-sandbox-20260820t031500z-m",
      sizeTier: "M",
      status: "ready",
    });
    expect(store.getDefaultImage("modal")?.name).toBe(
      "bb-sandbox:20260820t031500z",
    );
    await fake.harness.dispose();
  });

  it("opens the image row before registering and fails it in place", async () => {
    const observed: string[] = [];
    const { fake, manager } = await registrationHarness(async (_input, store) => {
      // The row exists while the provider call runs, so `bb sandbox images`
      // and the polling CLI are never blind to work in flight.
      observed.push(...store.listImages("daytona").map((image) => image.status));
      throw new Error("daytona rejected the snapshot");
    });

    const handle = await manager.startRegistration({ provider: "daytona", sizeTier: "M" });
    const status = await untilSettled(manager, handle.id);

    expect(observed).toEqual(["building"]);
    expect(status.state).toBe("error");
    expect(status.error).toContain("daytona rejected the snapshot");
    expect(status.images[0]).toMatchObject({
      status: "error",
      error: "daytona rejected the snapshot",
      name: "bb-sandbox-20260820t031500z-m",
      isDefault: false,
    });
    await fake.harness.dispose();
  });
});

function runtimeConfig(): SandboxRuntimeConfig {
  return {
    daytona: null,
    modal: null,
    e2b: null,
    box: null,
    freestyle: null,

    idleSleepMs: null,
    defaultSizeTier: "M",
    copyGitHubCliAuth: false,
    sandboxEnv: {},
    image: {
      repository: "ghcr.io/fixture-owner/sandbox-image",
      username: null,
      token: null,
      platform: "linux/amd64",
    },
  };
}

async function cliHarness(job: SandboxImageJobStatus) {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const db = fake.bb.storage.database();
  fake.bb.storage.migrate(db, [...sandboxMigrations]);
  const store = new SandboxStore(db);
  const manager = new SandboxManager(fake.bb, store, {
    config: runtimeConfig(),
  });
  const polls: number[] = [];
  registerSandboxCli(fake.bb, manager, {
    registerImage: async () => ({
      id: job.id,
      kind: "register",
      version: job.version,
      reference: job.reference,
      pinnedReference: job.pinnedReference,
      imageIds: job.imageIds,
    }),
    imageJob: (_id, cursor) => {
      polls.push(cursor);
      return job;
    },
  });
  return { fake, polls };
}

function jobStatus(
  overrides: Partial<SandboxImageJobStatus> = {},
): SandboxImageJobStatus {
  return {
    id: "job_9",
    kind: "register",
    version: "20260820t031500z",
    reference: "ghcr.io/fixture-owner/sandbox-image:20260820t031500z",
    pinnedReference: `ghcr.io/fixture-owner/sandbox-image@${digest}`,
    imageIds: ["img_9"],
    state: "ready",
    error: null,
    progress: [],
    cursor: 0,
    images: [],
    build: null,
    ...overrides,
  };
}

describe("the polling sandbox image CLI", () => {
  it("reports a terminal error row and exits non-zero without hanging", async () => {
    const { fake, polls } = await cliHarness(
      jobStatus({
        state: "error",
        error: "daytona rejected the snapshot",
        progress: ["Newest tag is 20260820t031500z"],
        cursor: 1,
        images: [
          {
            id: "img_9",
            provider: "daytona",
            name: "bb-sandbox-20260820t031500z",
            status: "error",
            isDefault: false,
            extraPackages: [],
            error: "daytona rejected the snapshot",
            regionId: null,
            sandboxClass: null,
            bbAppVersion: null,
            sizeTier: null,
            imageVersion: null,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    );

    const result = await fake.harness.runCli(["register-image"]);

    // A terminal row ends the loop on the first poll rather than waiting out
    // the whole watch window.
    expect(polls).toEqual([0]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Newest tag is 20260820t031500z");
    expect(result.stdout).toContain(
      "daytona\terror\tdaytona rejected the snapshot",
    );
    expect(result.stderr).toContain("daytona rejected the snapshot");
    await fake.harness.dispose();
  });

  it("hands back a resume command instead of blocking past the bridge cap", async () => {
    const { fake, polls } = await cliHarness(
      jobStatus({ state: "running", pinnedReference: null }),
    );

    const result = await fake.harness.runCli(["register-image", "--no-wait"]);

    expect(polls).toEqual([0]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bb sandbox image-status job_9");
    await fake.harness.dispose();
  });

  it("watches an already-running job by id", async () => {
    const { fake } = await cliHarness(
      jobStatus({ state: "ready", build: null }),
    );

    const result = await fake.harness.runCli([
      "image-status",
      "job_9",
      "--no-wait",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "").job).toMatchObject({
      id: "job_9",
      state: "ready",
    });
    await fake.harness.dispose();
  });
});
