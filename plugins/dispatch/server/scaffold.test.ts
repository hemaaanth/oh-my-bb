import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { METHOD_NAMES, RECEIVE_METHOD } from "../shared/contract.js";
import plugin from "./index.js";
import { MIGRATION_IDS } from "./migrations.js";
import { SETUP_FORMATS, SETUP_SETTINGS } from "./settings.js";

async function load(settings?: Record<string, string>) {
  const { bb, harness } = createFakePluginHost({ pluginId: "dispatch", ...(settings ? { settings } : {}) });
  await plugin(bb);
  return { bb, harness };
}

describe("needs-configuration banner", () => {
  it("asks once for the OpenAI key when it is missing", async () => {
    const { harness } = await load();
    const messages = harness.inspection.needsConfigurationMessages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("OpenAI API key");
    expect(messages[0]).toContain("Dispatch settings");
    expect(messages[0]).toContain("bb plugin config dispatch set openaiKey");
  });

  it("treats a blank key as missing", async () => {
    const { harness } = await load({ openaiKey: "   " });
    expect(harness.inspection.needsConfigurationMessages).toHaveLength(1);
  });

  it("stays quiet when the key is set, even with every phone field missing", async () => {
    const { harness } = await load({ openaiKey: "sk-test" });
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
  });
});

describe("setup settings", () => {
  it("declares six secret strings in CONTRACTS §7 order", async () => {
    const { harness } = await load();
    const descriptors = harness.registrations.settingsDescriptors;
    expect(Object.keys(descriptors)).toEqual(["openaiKey", "twilioSid", "twilioToken", "twilioCallerNumber", "yourPhoneNumber", "openaiSipProject"]);
    for (const descriptor of Object.values(descriptors)) {
      expect(descriptor).toMatchObject({ type: "string", secret: true });
    }
    expect(descriptors.openaiKey?.label).toBe("In-app voice — OpenAI API key");
    expect(SETUP_SETTINGS.openaiKey.description).toMatch(/subscription tokens do not work/);
  });

  it.each([
    ["openaiKey", "sk-proj-abc", "sk proj"],
    ["twilioSid", `AC${"0a".repeat(16)}`, "AC123"],
    ["twilioToken", "abc123", "abc 123"],
    ["twilioCallerNumber", "+14155550100", "4155550100"],
    ["yourPhoneNumber", "+447700900123", "+0123456789"],
    ["openaiSipProject", "proj_Abc123", "project_abc"],
  ] as const)("checks the %s format", (id, good, bad) => {
    expect(SETUP_FORMATS[id].safeParse(good).success).toBe(true);
    expect(SETUP_FORMATS[id].safeParse(bad).success).toBe(false);
    expect(SETUP_FORMATS[id].safeParse("").success).toBe(true);
  });
});

describe("storage", () => {
  it("lists migrations 001 to 004", () => {
    expect(MIGRATION_IDS).toEqual(["001-calls", "002-call-trace", "003-instruction-revisions", "004-legacy-token-usage"]);
  });

  it("creates every table and index at load", async () => {
    const { bb } = await load();
    const rows = bb.storage
      .database()
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")
      .all() as Array<{ type: string; name: string }>;
    const names = rows.map((row) => `${row.type}:${row.name}`);
    for (const expected of [
      "table:calls",
      "index:calls_started",
      "table:call_trace",
      "index:call_trace_call_at",
      "table:instruction_revisions",
      "table:legacy_token_usage",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("registration", () => {
  it("registers every RPC method and publishes only webhooks_receive", async () => {
    const { harness } = await load();
    expect([...harness.registrations.rpcMethods].sort()).toEqual([...METHOD_NAMES, RECEIVE_METHOD].sort());
    expect(harness.registrations.experimental_publishedRpcMethods.map((entry) => entry.method)).toEqual([RECEIVE_METHOD]);
  });

  it("registers every CLI subcommand from CONTRACTS §8", async () => {
    const { harness } = await load();
    const cli = harness.registrations.cli;
    expect(cli?.name).toBe("dispatch");
    expect(cli?.commands.map((command) => command.name).sort()).toEqual(
      ["call", "import", "live", "mute", "read", "status", "stop", "unmute", "usage"].sort(),
    );
  });

});

describe("wiring", () => {
  it("bb dispatch --help lists every command from core, phone and import", async () => {
    const { harness } = await load();
    const help = await harness.runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    const listed = [...help.stdout.matchAll(/^ {2}bb dispatch ([a-z]+) /gm)].map((match) => match[1]);
    expect(listed).toEqual(["live", "read", "usage", "stop", "mute", "unmute", "status", "call", "import"]);
  });

  it("the import command takes --apply, --dry-run, --include-legacy-usage and --json", async () => {
    const { harness } = await load();
    const help = await harness.runCli(["import", "--help"]);
    expect(help.exitCode).toBe(0);
    for (const flag of ["--from", "--apply", "--dry-run", "--include-legacy-usage", "--json"]) expect(help.stdout).toContain(flag);
  });
});
