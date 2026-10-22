import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import {
  checkoutRemoteBranch,
  resolveProjectRemoteUrl,
} from "../src/manager.js";

/**
 * Stand in for bb's terminal API. A real session only serves output while it is
 * running, so `output` here refuses to replay once the session has exited —
 * exactly as the server does with its 409 `terminal_output_unavailable`.
 */
function fakeTerminals(script: {
  respond: (input: string) => string;
  exitAfterInput?: boolean;
}) {
  const state = {
    status: "running" as "running" | "exited" | "disconnected",
    chunks: [] as { seq: number; dataBase64: string }[],
  };
  let seq = 0;
  const close = vi.fn(async () => undefined);
  return {
    close,
    state,
    sdk: {
      terminals: {
        create: vi.fn(async () => ({
          id: "term_1",
          status: state.status,
          exitCode: null,
        })),
        get: vi.fn(async () => ({
          id: "term_1",
          status: state.status,
          exitCode: state.status === "exited" ? 1 : null,
        })),
        input: vi.fn(async ({ dataBase64 }: { dataBase64: string }) => {
          const input = Buffer.from(dataBase64, "base64").toString("utf8");
          const emitted = script.respond(input);
          if (emitted.length > 0) {
            state.chunks.push({
              seq: seq++,
              dataBase64: Buffer.from(emitted).toString("base64"),
            });
          }
          if (script.exitAfterInput === true) state.status = "exited";
        }),
        output: vi.fn(async ({ sinceSeq }: { sinceSeq?: number }) => {
          if (state.status !== "running") {
            throw new Error(
              "HTTP 409: Terminal output is unavailable because the session is not running",
            );
          }
          const from = sinceSeq ?? 0;
          const chunks = state.chunks.filter((chunk) => chunk.seq >= from);
          return { chunks, nextSeq: seq, truncated: false };
        }),
        close,
      },
    },
  };
}

/** Echo the fenced markers a runHostCommand shell would print. */
function markers(input: string, exitCode: number, body: string): string {
  const start = /__BB_SANDBOX_START_([a-f0-9]+)__/u.exec(input);
  const done = /__BB_SANDBOX_DONE_([a-f0-9]+)__/u.exec(input);
  if (start === null || done === null) return "";
  return `\n${start[0]}\n${body}\n${done[0]}${exitCode}\n`;
}

describe("checkoutRemoteBranch", () => {
  it("reports the git failure instead of a terminal-output error", async () => {
    const terminals = fakeTerminals({
      respond: (input) =>
        markers(
          input,
          1,
          "fatal: 'origin/main' is not a commit and a branch 'main' cannot be created from it",
        ),
    });
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: terminals.sdk,
    });

    await expect(
      checkoutRemoteBranch(fake.bb, "host_1", "/root/repo", "origin/main"),
    ).rejects.toThrow(
      /Could not check out origin\/main.*not a commit and a branch 'main' cannot be created/su,
    );
    expect(terminals.close).toHaveBeenCalled();
  });

  it("resolves when the checkout succeeds", async () => {
    const terminals = fakeTerminals({
      respond: (input) => markers(input, 0, "Switched to a new branch 'main'"),
    });
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: terminals.sdk,
    });

    await expect(
      checkoutRemoteBranch(fake.bb, "host_1", "/root/repo", "origin/main"),
    ).resolves.toBeUndefined();
  });

  it("rejects branches that are not remote origin refs", async () => {
    const fake = createFakePluginHost({ pluginId: "sandboxes" });
    await expect(
      checkoutRemoteBranch(fake.bb, "host_1", "/root/repo", "main"),
    ).rejects.toThrow(/must be remote origin/u);
  });
});

describe("resolveProjectRemoteUrl", () => {
  const sources = [
    { hostId: "host_local", isDefault: true, path: "/home/me/Projects/sher" },
  ];

  it("prefers the default source's origin over a stale project anchor", async () => {
    const terminals = fakeTerminals({
      respond: (input) =>
        markers(input, 0, "https://github.com/sher-ing/sher.git"),
    });
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: terminals.sdk,
    });

    await expect(
      resolveProjectRemoteUrl(fake.bb, {
        gitRemoteUrl: "https://github.com/hemaaanth/sher",
        sources,
      }),
    ).resolves.toBe("https://github.com/sher-ing/sher.git");
  });

  it("falls back to the recorded anchor when the source host cannot answer", async () => {
    const terminals = fakeTerminals({
      respond: (input) => markers(input, 128, "fatal: not a git repository"),
    });
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: terminals.sdk,
    });

    await expect(
      resolveProjectRemoteUrl(fake.bb, {
        gitRemoteUrl: "https://github.com/hemaaanth/sher",
        sources,
      }),
    ).resolves.toBe("https://github.com/hemaaanth/sher");
  });

  it("uses the anchor when the project has no sources", async () => {
    const fake = createFakePluginHost({ pluginId: "sandboxes" });
    await expect(
      resolveProjectRemoteUrl(fake.bb, {
        gitRemoteUrl: "https://github.com/hemaaanth/sher",
        sources: [],
      }),
    ).resolves.toBe("https://github.com/hemaaanth/sher");
  });
});
