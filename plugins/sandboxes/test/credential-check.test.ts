import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { providerCredentialChecks } from "../src/credential-check.js";
import type { SandboxSettings } from "../src/config.js";

it("keeps settings reads local, validates explicitly and invalidates changed credentials", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  let settings = { daytonaApiKey: "", daytonaApiUrl: "https://fixture.invalid", modalTokenId: "", modalTokenSecret: "", e2bApiKey: "", boxApiKey: "", freestyleApiKey: "" } as SandboxSettings;
  const check = vi.fn(async () => {});
  const checks = providerCredentialChecks(fake.bb, async () => settings, check);
  try {
    expect(await checks.read("daytona")).toBe("missing");
    expect(await checks.verify("daytona")).toBe("missing");
    expect(check).not.toHaveBeenCalled();
    settings = { ...settings, daytonaApiKey: "fixture-private-key" };
    expect(await checks.read("daytona")).toBe("unchecked");
    expect(await checks.verify("daytona")).toBe("valid");
    expect(await checks.read("daytona")).toBe("valid");
    expect(check).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await fake.bb.storage.kv.get("credential-check:daytona"))).not.toContain(settings.daytonaApiKey);
    settings = { ...settings, daytonaApiKey: "changed-fixture-key" };
    expect(await checks.read("daytona")).toBe("unchecked");
    check.mockRejectedValueOnce(Error("private-provider-error"));
    expect(await checks.verify("daytona")).toBe("invalid");
    expect(JSON.stringify(fake.harness.logEntries)).not.toContain("private-provider-error");
  } finally { await fake.harness.dispose(); }
});

it("does not accept a check completed after its credentials changed", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  let settings = { e2bApiKey: "fixture-a" } as SandboxSettings;
  const checks = providerCredentialChecks(fake.bb, async () => settings, async () => { settings = { ...settings, e2bApiKey: "fixture-b" }; });
  try {
    expect(await checks.verify("e2b")).toBe("unchecked");
    expect(await fake.bb.storage.kv.get("credential-check:e2b")).toBeUndefined();
  } finally { await fake.harness.dispose(); }
});
