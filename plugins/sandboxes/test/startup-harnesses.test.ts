import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { harnessNames, prepareGatewayHarnesses, type HarnessVersions } from "../src/upgrade.js";
import { reconcileGatewaySetup } from "../src/gateway-setup.js";

vi.mock("../src/gateway-setup.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/gateway-setup.js")>(),
  reconcileGatewaySetup: vi.fn(async () => ({ current: true, revision: "fixture", files: [] })),
}));
afterEach(() => vi.clearAllMocks());
const target: HarnessVersions = {
  "claude-code": "2.1.296", codex: "0.162.1", omp: "18.10.3", fx: "0.0.13",
  pi: "1.2.0", "prime-agent": "0.10.0", "fx-acp": "a".repeat(64),
  "nanocodex-acp": "b".repeat(64), "prime-agent-acp": "c".repeat(64),
};
async function check(carried: HarnessVersions, healed = target, custom = false, tools: string[] | null = null) {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const exec = vi.fn<MachineExecutor["exec"]>(async request => {
    const versions = exec.mock.calls.length === 1 ? carried : healed;
    request.onOutput(`BB-UPGRADE-RESULT ${JSON.stringify({ bb: "0.47.1", ...versions })}\n`);
    return { exitCode: 0 };
  });
  try {
    await prepareGatewayHarnesses(fake.bb, { hostId: "host-fixture", executor: { exec }, signal: new AbortController().signal }, { target: custom ? null : target, tools });
    return exec;
  } finally { await fake.harness.dispose(); }
}
it("replaces an old vendor Claude even when every harness is present", async () => {
  const exec = await check({ ...target, "claude-code": "2.1.234" });
  expect(exec).toHaveBeenCalledTimes(3);
  expect(exec.mock.calls[1]![0].command.join(" ")).toContain("CLAUDE_CODE_VERSION=2.1.296");
  expect(reconcileGatewaySetup).toHaveBeenCalledOnce();
});
it("skips installation when the common image versions already match", async () => {
  expect(await check(target)).toHaveBeenCalledTimes(2);
});
it("retains installed versions only for an explicit custom image", async () => {
  expect(await check({ ...target, "claude-code": "2.1.234" }, target, true)).toHaveBeenCalledTimes(2);
});
it("preserves disabled tools from the shared image selection", async () => {
  const disabled = Object.fromEntries(harnessNames.map(name => [name, "disabled"])) as HarnessVersions;
  const exec = await check(disabled, target, false, []);
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec.mock.calls[0]![0].command.slice(0, 2)).toEqual(["env", "BB_IMAGE_TOOLS="]);
});
it("stops before Gateway setup when an old harness survives repair", async () => {
  const old = { ...target, "claude-code": "2.1.234" };
  await expect(check(old, old)).rejects.toThrow("Claude Code 2.1.234 → 2.1.296");
  expect(reconcileGatewaySetup).not.toHaveBeenCalled();
});
