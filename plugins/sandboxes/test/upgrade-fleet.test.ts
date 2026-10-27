import {
  createFakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerSandboxCli } from "../src/cli.js";
import type { SandboxRuntimeConfig } from "../src/config.js";
import { SandboxManager } from "../src/manager.js";
import { sandboxMigrations, SandboxStore } from "../src/store.js";
import type { VersionAudit } from "../src/version-audit.js";

function runtimeConfig(): SandboxRuntimeConfig {
  return {
    daytona: {
      apiKey: "daytona-secret",
      snapshot: "bb-sandbox-test",
      sandboxClass: "container",
    },
    modal: null,
    e2b: null,
    box: null,
    freestyle: null,

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

describe("fleet upgrades", () => {
  it("prints version findings with their fixes in bb sandbox doctor", async () => {
    const fake = createFakePluginHost({ pluginId: "sandboxes" });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const manager = new SandboxManager(fake.bb, new SandboxStore(db), {
      config: runtimeConfig(),
    });
    const audit: VersionAudit = {
      serverVersion: "0.42.0",
      previousServerVersion: "0.40.0",
      images: [],
      pins: [
        {
          projectId: "proj_monorepo",
          provider: "daytona",
          imageId: "img_old",
          imageName: "bb-sandbox-old",
          bbAppVersion: "0.38.0",
          state: "behind",
        },
      ],
      sandboxes: [],
      sizeTiers: [],
      findings: [
        {
          severity: "error",
          code: "pin-behind",
          provider: "daytona",
          projectId: "proj_monorepo",
          message: "Project proj_monorepo is pinned to bb-sandbox-old",
          fix: "bb sandbox clear-project-image --provider daytona --project proj_monorepo",
        },
      ],
      checkedAt: 1,
    };
    registerSandboxCli(fake.bb, manager, {
      versionDoctor: async () => audit,
    });
    const text = await fake.harness.runCli(["doctor"]);
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toContain("bb 0.42.0 (upgraded from 0.40.0): 1 project pin(s)");
    expect(text.stdout).toContain("ERROR\tbb pin-behind: Project proj_monorepo is pinned to bb-sandbox-old");
    expect(text.stdout).toContain(
      "\tfix: bb sandbox clear-project-image --provider daytona --project proj_monorepo",
    );
    const structured = await fake.harness.runCli(["doctor", "--json"]);
    expect(JSON.parse(structured.stdout ?? "")).toMatchObject({
      versions: { serverVersion: "0.42.0", findings: [{ code: "pin-behind" }] },
    });
    await fake.harness.dispose();
  });
});
