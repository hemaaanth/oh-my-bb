// Test helpers for the P1 server tests. Not imported by the plugin.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { DISPATCH_VERSION } from "../shared/constants.js";
import type { DeviceProfile, ToolContext } from "../shared/contract.js";
import type { ServerContext } from "./context.js";
import plugin from "./index.js";
import { MIGRATION_STATEMENTS } from "./migrations.js";
import { SETUP_SETTINGS, isPresent } from "./settings.js";

type FakeOptions = NonNullable<Parameters<typeof createFakePluginHost>[0]>;
export type Stubs = NonNullable<FakeOptions["sdk"]>;

/** Every setup field with a plausible value. None of them is a real secret. */
export const FULL_SETUP = {
  openaiKey: "sk-test-voice-key-0000",
  twilioSid: "AC00000000000000000000000000000000",
  twilioToken: "twilio-token-secret-1111",
  twilioCallerNumber: "+15550000001",
  yourPhoneNumber: "+15550000002",
  openaiSipProject: "proj_test2222",
} as const;

/** Stubs every test needs, so readiness and the prompt never hit an unstubbed method. */
export const BASE_STUBS = {
  plugins: { list: async () => ({ plugins: [] }), reload: async () => ({}) },
  projects: { list: async () => [] },
  hosts: { list: async () => [] },
  threads: { list: async () => [] },
} as Stubs;

function merge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const prior = out[key];
    out[key] =
      typeof value === "object" && value !== null && typeof prior === "object" && prior !== null
        ? merge(prior as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

const hostWith = (settings: Record<string, string> | undefined, stubs: Stubs | undefined) =>
  createFakePluginHost({
    pluginId: "dispatch",
    ...(settings ? { settings } : {}),
    sdk: merge(BASE_STUBS as Record<string, unknown>, (stubs ?? {}) as Record<string, unknown>) as Stubs,
  });

/** Load the whole plugin, as the host would. */
export async function loadPlugin(settings?: Record<string, string>, stubs?: Stubs) {
  const { bb, harness } = hostWith(settings, stubs);
  await plugin(bb);
  return { bb, harness };
}

/** A ServerContext without registering anything, for unit tests of one module. */
export async function makeContext(settings?: Record<string, string>, stubs?: Stubs) {
  const { bb, harness } = hostWith(settings, stubs);
  const handle = bb.settings.define(SETUP_SETTINGS);
  const values = await handle.get();
  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATION_STATEMENTS]);
  const ctx: ServerContext = { bb, settings: handle, db, needsConfiguration: !isPresent(values.openaiKey), version: DISPATCH_VERSION };
  return { ctx, bb, harness };
}

/** Realtime payloads published on one channel. */
export function published(harness: { inspection: { realtimeSignals: Array<{ channel: string; payload: unknown }> } }, channel: string): unknown[] {
  return harness.inspection.realtimeSignals.filter((signal) => signal.channel === channel).map((signal) => signal.payload);
}

export const APP_CONTEXT: ToolContext = {
  threadId: null,
  projectId: null,
  onNewThreadScreen: false,
  mobile: false,
  canNavigate: true,
  channel: "app",
};
export const PHONE_CONTEXT: ToolContext = { ...APP_CONTEXT, channel: "phone", canNavigate: false };

export const DESKTOP_DEVICE: DeviceProfile = {
  platform: "macos",
  mobile: false,
  browser: "chrome",
  displayMode: "browser",
  runtime: "browser",
  label: "Chrome on Mac",
};

// ---------------------------------------------------------------------------
// Loose SDK rows. Only the fields Dispatch reads are filled in.

export const pluginRow = (overrides: Record<string, unknown> = {}) => ({
  id: "notes",
  name: "Notes",
  enabled: true,
  status: "running",
  cliCommand: { name: "notes", summary: "Read and write notes" },
  ...overrides,
});

export const hostRow = (overrides: Record<string, unknown> = {}) => ({ id: "host_a", name: "studio", status: "connected", ...overrides });

export const projectRow = (overrides: Record<string, unknown> = {}) => ({
  id: "proj_a",
  name: "Website",
  kind: "standard",
  gitRemoteUrl: "git@example.com:me/website.git",
  sources: [{ hostId: "host_a", path: "/src/website", isDefault: true }],
  ...overrides,
});

export const threadRow = (overrides: Record<string, unknown> = {}) => ({
  id: "thr_a",
  title: "Fix the header",
  titleFallback: null,
  projectId: "proj_a",
  visibility: "visible",
  runtime: { displayStatus: "active" },
  updatedAt: Date.now(),
  environmentId: "env_a",
  environmentHostId: "host_a",
  environmentName: "studio",
  providerId: "codex",
  ...overrides,
});
