import { defineRpcContract, type BbPluginApi, type ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PreparationObservation } from "./preparation-outcome.js";

/** Longest single host call the daemon accepts. */
export const MAX_HOST_CALL_MS = 30 * 60_000;

export const hostContract = defineRpcContract({
  // Runs one program without a shell. A command starting with "~/" resolves
  // against the host home directory.
  run: {
    input: z.object({
      cwd: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()),
      stdin: z.string().optional(),
      timeoutMs: z.number().int().positive().max(MAX_HOST_CALL_MS),
    }).strict(),
    output: z.object({
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      timedOut: z.boolean(),
    }).strict(),
  },
  home: {
    input: z.object({}).strict(),
    output: z.object({ home: z.string() }).strict(),
  },
  bootstrap: {
    input: z.object({ opVersion: z.string().min(1) }).strict(),
    output: z.object({ home: z.string(), miseInstalled: z.boolean(), opEnvironmentSupported: z.boolean() }).strict(),
  },
  probe: {
    input: z.object({ cwd: z.string().min(1), commands: z.array(z.string().min(1)) }).strict(),
    output: z.object({ missing: z.array(z.string()), gitCommonDir: z.string().nullable() }).strict(),
  },
  stage: {
    input: z.object({
      tokenPath: z.string().min(1),
      token: z.string().min(1),
      helperPath: z.string().min(1),
      helperSource: z.string().min(1),
      metadataPath: z.string().min(1),
      metadata: z.string().min(1),
    }).strict(),
    output: z.object({}).strict(),
  },
  cleanup: {
    input: z.object({ cwd: z.string().min(1), profileId: z.string().min(1), preserveSharedToken: z.boolean() }).strict(),
    output: z.object({}).strict(),
  },
});

export type HostClient = ExperimentalHostClient<typeof hostContract>;

function createHostClient(bb: BbPluginApi) {
  return bb.hosts.experimental_client({ contract: hostContract });
}

const clients = new WeakMap<BbPluginApi, HostClient>();

export function hostClient(bb: BbPluginApi, observation?: PreparationObservation): HostClient {
  let client = clients.get(bb);
  if (!client) {
    client = createHostClient(bb);
    clients.set(bb, client);
  }
  if (!observation) return client;
  const raw = client;
  return {
    ...raw,
    call: (method, input, options) => observation.observeHost(method, () => raw.call(method, input, options)),
  };
}

// Leaves the host call a minute of headroom so the command's own timeout is
// what reports a slow run.
export function runCommand(host: HostClient, hostId: string, input: { cwd: string; command: string; args: string[]; stdin?: string; timeoutMs: number }, signal?: AbortSignal) {
  return host.call("run", input, { hostId, signal, timeoutMs: Math.min(input.timeoutMs + 60_000, MAX_HOST_CALL_MS) });
}
