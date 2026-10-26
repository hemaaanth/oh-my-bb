// Behavioral coverage for the `bb pinpoint` CLI mutation surface under the
// SDK fake host — the registered run() invoked through harness.behavior.runCli
// with real host semantics, not source-regex assertions:
//   * human-only guards: approve/delete reject any invocation carrying a
//     thread context, and succeed on owned rows without one;
//   * cross-project guard: ready/ask/reject/approve/delete against a row
//     belonging to another project are rejected; owned rows succeed;
//   * ready flags: --scope records a DECLARED scope (invalid → usage error),
//     --receipt-file reads and stores the file (missing → clear error),
//     --learning stores the proposal (path-bearing text → dropped with the
//     reason while the resolution still becomes ready — AE3 via CLI);
//   * ask moves a dispatched row to waiting-input and appends the question to
//     the annotation conversation;
//   * delete removes the row, its routing claim, and its screenshot rows.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import plugin, { type PinpointAnnotation } from "./server";

type CaptureOutput = { row: PinpointAnnotation; dispatched: boolean };
type ListOutput = { rows: PinpointAnnotation[] };

const PROJECT = "project-test";
const OTHER_PROJECT = "project-other";
const THREAD = "thread-1";

const CAPTURE = {
  threadId: THREAD,
  url: "http://localhost:3000/pricing",
  comment: "align the buttons",
};

async function makeHost() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "pinpoint",
    sdk: {
      threads: {
        get: async () => ({ projectId: PROJECT, environmentId: null }),
        send: async () => ({}),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          gitRemoteUrl: null,
        }),
      },
    },
  });
  await plugin(bb);
  return harness;
}

type Harness = Awaited<ReturnType<typeof makeHost>>;

/** Capture through the real RPC; default settings auto-dispatch the row. */
async function capture(
  harness: Harness,
  extra?: Record<string, unknown>,
): Promise<string> {
  const out = (await harness.behavior.callRpc("capture", {
    ...CAPTURE,
    ...extra,
  })) as CaptureOutput;
  expect(out.dispatched).toBe(true);
  return out.row.annotation.id;
}

async function rowById(harness: Harness, id: string): Promise<PinpointAnnotation> {
  const listed = (await harness.behavior.callRpc("list", {
    threadId: THREAD,
  })) as ListOutput;
  const row = listed.rows.find((r) => r.annotation.id === id);
  expect(row).toBeDefined();
  return row!;
}

function pinpointOf(row: PinpointAnnotation) {
  return row.annotation.pinpoint as {
    scope?: { breadth: string; target: string; declared: boolean };
    receipt?: string;
    proposedLearning?: { topic: string; logicalKey: string; text: string };
  };
}

describe("bb pinpoint CLI human-only guards (approve/delete)", () => {
  it("approve: rejected with a thread context, succeeds on an owned ready row without one", async () => {
    const harness = await makeHost();
    const id = await capture(harness);
    // Move to ready first (approve requires the ready state).
    const readied = await harness.behavior.runCli(
      ["ready", id, "--summary", "unified the buttons"],
      { projectId: PROJECT },
    );
    expect(readied.exitCode).toBe(0);
    expect(readied.stdout).toContain(`marked ${id} ready for review`);

    // Agent invocation (thread context) → hard refusal, state untouched.
    const denied = await harness.behavior.runCli(["approve", id], {
      threadId: THREAD,
    });
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain(
      "approve is reserved for the user: it cannot run with a thread context",
    );
    expect((await rowById(harness, id)).workflowState).toBe("ready");

    // Human invocation (no thread context) → approved.
    const approved = await harness.behavior.runCli(["approve", id], {
      projectId: PROJECT,
    });
    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toContain(`approved ${id}`);
    expect((await rowById(harness, id)).workflowState).toBe("approved");
  });

  it("delete: rejected with a thread context, succeeds on an owned row without one", async () => {
    const harness = await makeHost();
    const id = await capture(harness);

    const denied = await harness.behavior.runCli(["delete", id], {
      threadId: THREAD,
    });
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain(
      "delete is reserved for the user: it cannot run with a thread context",
    );
    // Still present.
    await rowById(harness, id);

    const deleted = await harness.behavior.runCli(["delete", id], {
      projectId: PROJECT,
    });
    expect(deleted.exitCode).toBe(0);
    expect(deleted.stdout).toContain(`deleted ${id}`);
    const listed = (await harness.behavior.callRpc("list", {
      threadId: THREAD,
    })) as ListOutput;
    expect(listed.rows.find((r) => r.annotation.id === id)).toBeUndefined();
  });
});

describe("bb pinpoint CLI cross-project guard", () => {
  it("ready/ask/reject/approve/delete reject a foreign project's row; owned rows succeed", async () => {
    const harness = await makeHost();
    const readyId = await capture(harness);
    const askId = await capture(harness);
    const rejectId = await capture(harness);

    const foreign = { projectId: OTHER_PROJECT };
    const attempts: [string, string[]][] = [
      ["ready", ["ready", readyId, "--summary", "done"]],
      ["ask", ["ask", askId, "--question", "which variant?"]],
      ["reject", ["reject", rejectId, "--reason", "wontfix"]],
      ["approve", ["approve", readyId]],
      ["delete", ["delete", rejectId]],
    ];
    for (const [, argv] of attempts) {
      const denied = await harness.behavior.runCli(argv, foreign);
      expect(denied.exitCode).toBe(1);
      expect(denied.stderr).toContain("belongs to another project");
    }
    // Nothing moved.
    expect((await rowById(harness, readyId)).workflowState).toBe("dispatched");
    expect((await rowById(harness, askId)).workflowState).toBe("dispatched");
    expect((await rowById(harness, rejectId)).workflowState).toBe("dispatched");

    // Owned rows succeed — ready/reject via the resolved project id, ask via
    // a thread context (ask is agent-callable; only approve/delete are
    // human-only).
    const readied = await harness.behavior.runCli(
      ["ready", readyId, "--summary", "done"],
      { projectId: PROJECT },
    );
    expect(readied.exitCode).toBe(0);
    expect((await rowById(harness, readyId)).workflowState).toBe("ready");

    const asked = await harness.behavior.runCli(
      ["ask", askId, "--question", "which variant?"],
      { threadId: THREAD },
    );
    expect(asked.exitCode).toBe(0);
    expect((await rowById(harness, askId)).workflowState).toBe("waiting-input");

    const rejected = await harness.behavior.runCli(
      ["reject", rejectId, "--reason", "wontfix"],
      { projectId: PROJECT },
    );
    expect(rejected.exitCode).toBe(0);
    expect(rejected.stdout).toContain(`rejected ${rejectId}`);
    expect((await rowById(harness, rejectId)).workflowState).toBe("dismissed");
  });
});

describe("bb pinpoint ready flags", () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("--scope pattern:component records a DECLARED scope", async () => {
    const harness = await makeHost();
    const id = await capture(harness);

    const result = await harness.behavior.runCli(
      ["ready", id, "--summary", "unified variants", "--scope", "pattern:component"],
      { projectId: PROJECT },
    );
    expect(result.exitCode).toBe(0);

    const row = await rowById(harness, id);
    expect(row.workflowState).toBe("ready");
    expect(pinpointOf(row).scope).toEqual({
      breadth: "pattern",
      target: "component",
      declared: true,
    });
  });

  it("an invalid --scope value is a usage error and mutates nothing", async () => {
    const harness = await makeHost();
    const id = await capture(harness);

    const result = await harness.behavior.runCli(
      ["ready", id, "--scope", "pattern:bogus"],
      { projectId: PROJECT },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid --scope "pattern:bogus"');
    expect(result.stderr).toContain("usage: bb pinpoint ready");
    expect((await rowById(harness, id)).workflowState).toBe("dispatched");
  });

  it("--receipt-file reads the file and stores the receipt", async () => {
    const harness = await makeHost();
    const id = await capture(harness);
    tmp = mkdtempSync(join(tmpdir(), "pinpoint-cli-test-"));
    const receiptPath = join(tmp, "receipt.diff");
    const receipt = `--- a/Button.tsx\n+++ b/Button.tsx\n@@ padding fixed for ${id}\n`;
    writeFileSync(receiptPath, receipt, "utf8");

    const result = await harness.behavior.runCli(
      ["ready", id, "--summary", "fixed padding", "--receipt-file", receiptPath],
      { projectId: PROJECT },
    );
    expect(result.exitCode).toBe(0);

    const row = await rowById(harness, id);
    expect(row.workflowState).toBe("ready");
    expect(pinpointOf(row).receipt).toBe(receipt);
  });

  it("a missing --receipt-file yields a clear error and mutates nothing", async () => {
    const harness = await makeHost();
    const id = await capture(harness);
    const missing = join(tmpdir(), "pinpoint-cli-test-does-not-exist.diff");

    const result = await harness.behavior.runCli(
      ["ready", id, "--receipt-file", missing],
      { projectId: PROJECT },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`cannot read --receipt-file ${missing}`);
    expect((await rowById(harness, id)).workflowState).toBe("dispatched");
  });

  it("--learning stores a valid proposed learning", async () => {
    const harness = await makeHost();
    const id = await capture(harness);

    const result = await harness.behavior.runCli(
      [
        "ready",
        id,
        "--summary",
        "sentence-cased the headings",
        "--learning",
        "design:some-key:Prefer sentence case in headings",
      ],
      { projectId: PROJECT },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("NOT kept");

    const row = await rowById(harness, id);
    expect(row.workflowState).toBe("ready");
    expect(pinpointOf(row).proposedLearning).toEqual({
      topic: "design",
      logicalKey: "some-key",
      text: "Prefer sentence case in headings",
    });
  });

  it("AE3 via CLI: a path-bearing --learning is dropped with the reason while the row still becomes ready", async () => {
    const harness = await makeHost();
    const id = await capture(harness);

    const result = await harness.behavior.runCli(
      [
        "ready",
        id,
        "--summary",
        "fixed the header",
        "--learning",
        "design:header-fix:Header padding lives in /src/components/Header.tsx",
      ],
      { projectId: PROJECT },
    );
    // The resolution applied; the dropped proposal is a note, not an error.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`marked ${id} ready for review`);
    expect(result.stdout).toContain("NOT kept");
    expect(result.stdout).toContain("must not contain file paths");

    const row = await rowById(harness, id);
    expect(row.workflowState).toBe("ready");
    expect(pinpointOf(row).proposedLearning).toBeUndefined();
  });
});

describe("bb pinpoint ask", () => {
  it("moves a dispatched row to waiting-input and appends the question to the conversation", async () => {
    const harness = await makeHost();
    const id = await capture(harness);
    expect((await rowById(harness, id)).workflowState).toBe("dispatched");

    const question = "Should the primary button be filled or outlined?";
    const result = await harness.behavior.runCli(
      ["ask", id, "--question", question],
      { threadId: THREAD },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`asked — ${id} is now waiting for the user's input`);

    const row = await rowById(harness, id);
    expect(row.workflowState).toBe("waiting-input");
    const thread = row.annotation.thread as { role: string; content: string }[];
    const last = thread[thread.length - 1]!;
    expect(last.role).toBe("agent");
    expect(last.content).toBe(question);
  });

  it("requires question text", async () => {
    const harness = await makeHost();
    const id = await capture(harness);

    const result = await harness.behavior.runCli(["ask", id], {
      threadId: THREAD,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("usage: bb pinpoint ask");
    expect((await rowById(harness, id)).workflowState).toBe("dispatched");
  });
});

describe("bb pinpoint delete cleanup", () => {
  it("removes the row, its routing, and its screenshot rows", async () => {
    const harness = await makeHost();
    // Picker-originated capture with a known id for its scoped screenshot RPC.
    const id = "pp_clidel1";
    await capture(harness, { clientId: id });
    await harness.behavior.callRpc("uploadScreenshot", {
      threadId: THREAD, clientId: id, kind: "element", mime: "image/webp",
      screenshot: "dGVzdA==", url: CAPTURE.url,
    });
    expect((await rowById(harness, id)).screenshots).toEqual(["element"]);

    const deleted = await harness.behavior.runCli(["delete", id], {
      projectId: PROJECT,
    });
    expect(deleted.exitCode).toBe(0);
    expect(deleted.stdout).toContain(`deleted ${id}`);

    // Row and routing are gone from every read surface…
    const listed = (await harness.behavior.callRpc("list", {
      threadId: THREAD,
    })) as ListOutput;
    expect(listed.rows.find((r) => r.annotation.id === id)).toBeUndefined();
    const shown = await harness.behavior.runCli(["show", id], {
      projectId: PROJECT,
    });
    expect(shown.exitCode).toBe(1);
    expect(shown.stderr).toContain(`no such item: ${id}`);

    // …and the screenshot rows went with them: re-capturing the SAME client
    // id yields a fresh row with no stored screenshots (screenshots key on
    // the annotation id, so an orphaned row would resurface here).
    await capture(harness, { clientId: id });
    expect((await rowById(harness, id)).screenshots).toEqual([]);
  });
});
