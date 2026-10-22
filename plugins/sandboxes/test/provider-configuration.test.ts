import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxProviderConfigurationStore } from "../src/provider-configuration.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("SandboxProviderConfigurationStore", () => {
  it("keeps provider secrets write-only and preserves them on blank updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-sandbox-provider-"));
    temporaryDirectories.push(root);
    const store = new SandboxProviderConfigurationStore(join(root, "data.db"));

    await store.setSecrets({ daytonaApiKey: "secret-value" });
    await store.setSecrets({ daytonaApiKey: "" });
    await store.updateConfiguration("daytona", {
      apiUrl: "https://example.test",
      target: "large",
    });

    expect(await store.credentialStatus("daytona")).toBe(true);
    expect(await store.getConfiguration()).toMatchObject({
      daytona: { apiUrl: "https://example.test", target: "large" },
    });
    const secretPath = join(root, "secrets", "daytonaApiKey");
    expect(await readFile(secretPath, "utf8")).toBe("secret-value");
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
  });
});
