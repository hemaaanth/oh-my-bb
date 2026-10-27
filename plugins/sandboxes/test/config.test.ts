import { describe, expect, it } from "vitest";
import {
  loadSandboxRuntimeConfig,
  sandboxImageRegistryConfig,
  type SandboxSettings,
} from "../src/config.js";

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
    nirvanaImageUri: "node:22-bookworm-slim",
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
    imageRegistry: "",
    imageRegistryUsername: "",
    imageRegistryToken: "",
    imagePlatform: "",
    ...overrides,
  };
}

describe("loadSandboxRuntimeConfig", () => {
  it("requires provider-native artifacts and passes only explicit Git secrets", () => {
    const config = loadSandboxRuntimeConfig(
      settings({ gitToken: "git-secret" }),
      {
        DAYTONA_API_KEY: "daytona-secret",
        OPENAI_API_KEY: "must-not-leak",
      },
    );
    expect(config.daytona).toBeNull();
    expect(config.sandboxEnv).toEqual({
      BB_SANDBOX_GIT_TOKEN: "git-secret",
    });
  });

  it("loads image-backed adapters from settings", () => {
    const config = loadSandboxRuntimeConfig(
      settings({
        daytonaApiKey: "d",
        daytonaSnapshot: "snapshot",
        modalTokenId: "m-id",
        modalTokenSecret: "m-secret",
        modalImageName: "bb-sandbox:test",
        e2bApiKey: "e",
        e2bTemplate: "template",
      }),
      {},
    );
    expect(config.daytona?.snapshot).toBe("snapshot");
    expect(config.modal?.imageName).toBe("bb-sandbox:test");
    expect(config.e2b?.template).toBe("template");
    expect(config.idleSleepMs).toBe(15 * 60 * 1_000);
  });

  it("loads portable providers and falls back from invalid numeric sizes", () => {
    const config = loadSandboxRuntimeConfig(
      settings({
        boxApiKey: "box",
        boxMachineClass: "large",
        freestyleApiKey: "freestyle",
        freestyleCpu: "not-a-number",
        freestylePersistence: "persistent",
        freestyleSnapshotId: "snapshot",
        nirvanaApiKey: "nirvana",
        nirvanaApiEndpoint: "https://api.example.com",
        nirvanaGatewayEndpoint: "https://gateway.example.com",
      }),
      {},
    );
    expect(config.box?.machineClass).toBe("large");
    expect(config.freestyle).toMatchObject({
      cpu: 4,
      persistence: "persistent",
      snapshotId: "snapshot",
    });
    expect(config.nirvana?.gatewayEndpoint).toBe("https://gateway.example.com");
  });

  it("allows Daytona and E2B automatic sleep to be disabled", () => {
    expect(
      loadSandboxRuntimeConfig(settings({ idleSleepAfter: "Never" }), {})
        .idleSleepMs,
    ).toBeNull();
  });

  it("prefers a managed image over the bootstrap artifact", () => {
    const config = loadSandboxRuntimeConfig(
      settings({ daytonaApiKey: "d", daytonaSnapshot: "bootstrap" }),
      {},
      { daytona: "managed" },
    );
    expect(config.daytona?.snapshot).toBe("managed");
  });

  it("points Nirvana at the registered image reference", () => {
    const config = loadSandboxRuntimeConfig(
      settings({
        nirvanaApiKey: "nirvana",
        nirvanaApiEndpoint: "https://api.example.com",
        nirvanaGatewayEndpoint: "https://gateway.example.com",
        nirvanaImageUri: "node:22-bookworm-slim",
      }),
      {},
      { nirvana: "ghcr.io/acme/bb-sandbox@sha256:abc" },
    );
    expect(config.nirvana?.imageUri).toBe(
      "ghcr.io/acme/bb-sandbox@sha256:abc",
    );
  });

  it("opts Modal into its VM runtime from settings or the environment", () => {
    const modal = settings({
      modalTokenId: "id",
      modalTokenSecret: "secret",
      modalImageName: "bb-sandbox:test",
    });
    expect(loadSandboxRuntimeConfig(modal, {}).modal?.vmRuntime).toBe(false);
    expect(
      loadSandboxRuntimeConfig(settings({ ...modal, modalVmRuntime: true }), {})
        .modal?.vmRuntime,
    ).toBe(true);
    expect(
      loadSandboxRuntimeConfig(modal, { BB_SANDBOX_MODAL_VM_RUNTIME: "1" })
        .modal?.vmRuntime,
    ).toBe(true);
  });
});

describe("sandboxImageRegistryConfig", () => {
  it("defaults the platform and reports an unset repository", () => {
    expect(sandboxImageRegistryConfig(settings(), {})).toEqual({
      repository: "",
      username: null,
      token: null,
      platform: "linux/amd64",
    });
  });

  it("prefers configured values over the environment", () => {
    expect(
      sandboxImageRegistryConfig(
        settings({
          imageRegistry: "ghcr.io/acme/bb-sandbox",
          imageRegistryUsername: "acme-bot",
          imageRegistryToken: "registry-token",
          imagePlatform: "linux/arm64",
        }),
        { BB_SANDBOX_IMAGE_REGISTRY: "example.com/ignored" },
      ),
    ).toEqual({
      repository: "ghcr.io/acme/bb-sandbox",
      username: "acme-bot",
      token: "registry-token",
      platform: "linux/arm64",
    });
  });

  it("falls back to the environment when nothing is configured", () => {
    expect(
      sandboxImageRegistryConfig(settings(), {
        BB_SANDBOX_IMAGE_REGISTRY: "ghcr.io/acme/bb-sandbox",
        BB_SANDBOX_IMAGE_REGISTRY_USERNAME: "acme-bot",
        BB_SANDBOX_IMAGE_REGISTRY_TOKEN: "registry-token",
        BB_SANDBOX_IMAGE_PLATFORM: "linux/arm64",
      }),
    ).toMatchObject({
      repository: "ghcr.io/acme/bb-sandbox",
      username: "acme-bot",
      platform: "linux/arm64",
    });
  });
});
