import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { parseProviderTranscript } from "./prompt-parser";
import type { PromptResult } from "./prompt-contract";
import plugin from "./server";

const lines = readFileSync(new URL("./fixtures/prompt-claude.jsonl", import.meta.url), "utf8").trim().split("\n");
const sessionId = "c0b4f488-91b5-4306-8fbc-a13f76725dba";
const secret = "opaque-secret-no-known-token-prefix";
const scan = () => ({ bytesRead: 0, linesRead: 0, malformedLines: 0, oversizedLines: 0, limited: false });

describe("prompt RPC and CLI boundary", () => {
  it("routes to the thread's environment host and re-redacts an unsafe host response", async () => {
    const thread = makeThreadResponse({ id: "thr_fixture", providerId: "claude-code", environmentId: "env_remote" });
    const result = await parseProviderTranscript(lines, { threadId: thread.id, provider: "claude-code", sessionId, call: 1, reveal: true }, scan());
    result.selected!.system[0]!.text = secret;
    const { bb, harness } = createFakePluginHost({ pluginId: "traces", experimental_hostEntry: true,
      sdk: { threads: { get: async () => thread, events: { list: async () => [{ type: "thread/identity", data: { providerThreadId: sessionId } }] } },
        environments: { get: async () => ({ hostId: "host_remote" }) as never } },
      experimental_callHostRpc: async () => result,
    });
    plugin(bb);
    const hidden = await harness.behavior.callRpc("traces_prompt", { threadId: thread.id, call: 1, reveal: false }) as PromptResult;
    expect(hidden.status).toBe("available");
    expect(JSON.stringify(hidden)).not.toContain(secret);
    expect(hidden.selected?.system[0]?.text).toBeNull();
    const text = await harness.behavior.runCli(["prompt", thread.id, "--call", "1"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("System sections");
    expect(text.stdout).toContain("Diff: first stored call; no previous prompt to compare.");
    expect(text.stdout).not.toContain(secret);
    const shown = await harness.behavior.callRpc("traces_prompt", { threadId: thread.id, call: 1, reveal: true }) as PromptResult;
    expect(shown.selected?.system[0]?.text).toBe(secret);
    const revealedText = await harness.behavior.runCli(["prompt", thread.id, "--call", "1", "--reveal"]);
    expect(revealedText.stdout).toContain(secret);
    expect(harness.inspection.experimental_hostRpcCalls.every((call) => call.hostId === "host_remote" && call.method === "promptRead")).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("reports unsupported providers without touching any transcript host", async () => {
    const thread = makeThreadResponse({ id: "thr_pi", providerId: "pi", environmentId: null });
    const { bb, harness } = createFakePluginHost({ pluginId: "traces", experimental_hostEntry: true,
      sdk: { threads: { get: async () => thread } }, experimental_callHostRpc: async () => { throw new Error("Must not run"); } });
    plugin(bb);
    const result = await harness.behavior.callRpc("traces_prompt", { threadId: thread.id, call: null, reveal: false }) as PromptResult;
    expect(result.status).toBe("unsupported");
    expect(result.selected).toBeNull();
    expect(harness.inspection.experimental_hostRpcCalls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("does not include raw host exceptions in RPC or CLI output", async () => {
    const thread = makeThreadResponse({ id: "thr_error", providerId: "codex", environmentId: "env_remote" });
    const { bb, harness } = createFakePluginHost({ pluginId: "traces", experimental_hostEntry: true,
      sdk: { threads: { get: async () => thread, events: { list: async () => [{ type: "thread/identity", data: { providerThreadId: sessionId } }] } },
        environments: { get: async () => ({ hostId: "host_remote" }) as never } },
      experimental_callHostRpc: async () => { throw new Error(`Path with ${secret}`); },
    });
    plugin(bb);
    const result = await harness.behavior.callRpc("traces_prompt", { threadId: thread.id, call: null, reveal: false }) as PromptResult;
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain(secret);
    const cli = await harness.behavior.runCli(["prompt", thread.id, "--json"]);
    expect(cli.stdout).not.toContain(secret);
    await harness.lifecycle.dispose();
  });
});
