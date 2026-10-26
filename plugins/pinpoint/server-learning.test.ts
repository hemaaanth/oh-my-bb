// Server-level consent-loop coverage (U8): the real `update` RPC and
// pinpoint_resolve tool running under the SDK fake host, with bb.sdk stubbed
// — so AE4 ("approve without opt-in never calls clasi") is asserted against
// the actual wiring, not just the lib. The LIVE cross-plugin callRpc against
// a running bb remains spike-deferred.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin, { type PinpointAnnotation } from "./server";

type UpdateOutput = { row: PinpointAnnotation; warning?: string };
type CaptureOutput = { row: PinpointAnnotation; dispatched: boolean };

const LEARNING = {
  topic: "design" as const,
  logicalKey: "button-consistency",
  text: "Use one shared button component per variant.",
};

async function makeHost(
  callRpcStub: (args: unknown) => Promise<unknown> = async () => ({
    id: "ctx-1",
  }),
  enabled = true,
) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "pinpoint",
    settings: { autoDispatch: false },
    sdk: {
      threads: {
        get: async () => ({ projectId: "project-test", environmentId: null }),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          gitRemoteUrl: null,
        }),
      },
      plugins: { callRpc: callRpcStub },
    },
  });
  await plugin(bb);
  if (enabled) await harness.behavior.callRpc("setIntegration", { integration: "clasi", enabled: true });
  return harness;
}

type Harness = Awaited<ReturnType<typeof makeHost>>;

async function captureReadyWithProposal(harness: Harness): Promise<string> {
  const captured = (await harness.behavior.callRpc("capture", {
    threadId: "thread-1",
    url: "http://localhost:3000/",
    comment: "align the buttons",
  })) as CaptureOutput;
  const id = captured.row.annotation.id;
  const resolved = await harness.behavior.callAgentTool("pinpoint_resolve", {
    id,
    outcome: "ready",
    summary: "unified the buttons",
    proposedLearning: LEARNING,
  });
  expect(JSON.stringify(resolved)).toContain("ready for review");
  return id;
}

function pinpointOf(row: PinpointAnnotation) {
  return row.annotation.pinpoint as {
    proposedLearning?: typeof LEARNING;
    learningConsent?: { approvedAt: number; text: string };
    learningWrite?:
      | { state: "saved"; at: number }
      | { state: "failed"; error: string };
  };
}

describe("Pinpoint consent loop through the live server wiring", () => {
  it("global opt-in off blocks approval writes and does not infer consent", async () => {
    const harness = await makeHost(undefined, false);
    const id = await captureReadyWithProposal(harness);
    const result = await harness.behavior.callRpc("update", {
      id, action: "approve", learning: true, approvedLearning: LEARNING,
    }) as UpdateOutput;
    expect(result.row.workflowState).toBe("approved");
    expect(result.warning).toContain("Enable Clasi learning");
    expect(pinpointOf(result.row).learningConsent).toBeUndefined();
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });

  it.each([
    undefined,
    { ...LEARNING, text: "Use unrelated text." },
    { ...LEARNING, logicalKey: "another-preference" },
    { ...LEARNING, topic: "copy" },
  ])("rejects a missing or stale proposal snapshot: %j", async (approvedLearning) => {
    const harness = await makeHost();
    const id = await captureReadyWithProposal(harness);
    const result = await harness.behavior.callRpc("update", {
      id, action: "approve", learning: true,
      ...(approvedLearning ? { approvedLearning } : {}),
    }) as UpdateOutput;
    expect(result.row.workflowState).toBe("approved");
    expect(result.warning).toContain("exact text");
    expect(pinpointOf(result.row).learningConsent).toBeUndefined();
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });

  it("disabling after failure blocks retry, and reenabling retains exact consent", async () => {
    let fail = true;
    const harness = await makeHost(async () => {
      if (fail) throw new Error("Clasi unavailable");
      return { id: "ctx-3" };
    });
    const id = await captureReadyWithProposal(harness);
    await harness.behavior.callRpc("update", {
      id, action: "approve", learning: true, approvedLearning: LEARNING,
    });
    await harness.behavior.callRpc("setIntegration", { integration: "clasi", enabled: false });
    fail = false;
    const blocked = await harness.behavior.callRpc("update", { id, action: "retry-learning" }) as UpdateOutput;
    expect(blocked.warning).toContain("Enable Clasi learning");
    expect(pinpointOf(blocked.row).learningConsent?.text).toBe(LEARNING.text);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    await harness.behavior.callRpc("setIntegration", { integration: "clasi", enabled: true });
    const saved = await harness.behavior.callRpc("update", { id, action: "retry-learning" }) as UpdateOutput;
    expect(pinpointOf(saved.row).learningWrite?.state).toBe("saved");
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(2);
  });

  it("AE4: approve WITHOUT the opt-in never calls clasi and stores nothing", async () => {
    const harness = await makeHost();
    const id = await captureReadyWithProposal(harness);

    const updated = (await harness.behavior.callRpc("update", {
      id,
      action: "approve",
    })) as UpdateOutput;

    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    const pinpoint = pinpointOf(updated.row);
    // The proposal stays visible as not-saved; no consent, no write mark.
    expect(pinpoint.proposedLearning).toEqual(LEARNING);
    expect(pinpoint.learningConsent).toBeUndefined();
    expect(pinpoint.learningWrite).toBeUndefined();
    expect(updated.row.workflowState).toBe("approved");
  });

  it("approve WITH learning:true records consent, writes to clasi, and marks saved", async () => {
    const harness = await makeHost();
    const id = await captureReadyWithProposal(harness);

    const updated = (await harness.behavior.callRpc("update", {
      id,
      action: "approve",
      learning: true,
      approvedLearning: LEARNING,
    })) as UpdateOutput;

    expect(updated.warning).toBeUndefined();
    const calls = harness.inspection.sdk.callsTo("plugins.callRpc");
    expect(calls).toHaveLength(1);
    const args = calls[0]![0] as { pluginId: string; method: string; input: unknown };
    expect(args.pluginId).toBe("clasi");
    expect(args.method).toBe("saveContext");
    expect(args.input).toEqual({
      scope: { type: "project", id: "project-test" },
      logicalKey: LEARNING.logicalKey,
      kind: "preference",
      value: LEARNING.text,
      priority: 50,
      topic: "design",
      provenance: "thread-1",
      consentRef: `pinpoint:${id}`,
    });
    const pinpoint = pinpointOf(updated.row);
    expect(pinpoint.learningConsent?.text).toBe(LEARNING.text);
    expect(pinpoint.learningWrite).toMatchObject({ state: "saved" });
    expect(updated.row.workflowState).toBe("approved");
  });

  it("a failing clasi write marks failed (approve still succeeds); retry-learning re-attempts", async () => {
    let fail = true;
    const harness = await makeHost(async () => {
      if (fail) throw new Error("plugin clasi is not installed");
      return { id: "ctx-2" };
    });
    const id = await captureReadyWithProposal(harness);

    const updated = (await harness.behavior.callRpc("update", {
      id,
      action: "approve",
      learning: true,
      approvedLearning: LEARNING,
    })) as UpdateOutput;

    // Approve and write are separate concerns: the approve succeeded…
    expect(updated.row.workflowState).toBe("approved");
    // …the write outcome is failed-with-retry, surfaced as a warning.
    expect(updated.warning).toContain("failed");
    expect(pinpointOf(updated.row).learningWrite).toEqual({
      state: "failed",
      error: "plugin clasi is not installed",
    });

    fail = false;
    const retried = (await harness.behavior.callRpc("update", {
      id,
      action: "retry-learning",
    })) as UpdateOutput;
    expect(retried.warning).toBeUndefined();
    expect(pinpointOf(retried.row).learningWrite).toMatchObject({
      state: "saved",
    });
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(2);
  });

  it("AE3 via the tool: an invalid proposal still resolves ready and returns the reason", async () => {
    const harness = await makeHost();
    const captured = (await harness.behavior.callRpc("capture", {
      threadId: "thread-1",
      url: "http://localhost:3000/",
      comment: "fix the header",
    })) as CaptureOutput;
    const id = captured.row.annotation.id;

    const result = await harness.behavior.callAgentTool("pinpoint_resolve", {
      id,
      outcome: "ready",
      summary: "fixed",
      proposedLearning: {
        topic: "design",
        logicalKey: "header-fix",
        text: "Header padding lives in /src/components/Header.tsx",
      },
    });

    const text = JSON.stringify(result);
    expect(text).toContain("ready for review");
    expect(text).toContain("NOT kept");
    const listed = (await harness.behavior.callRpc("list", {
      threadId: "thread-1",
      status: "ready",
    })) as { rows: PinpointAnnotation[] };
    const row = listed.rows.find((r) => r.annotation.id === id)!;
    expect(row.workflowState).toBe("ready");
    expect(pinpointOf(row).proposedLearning).toBeUndefined();
  });
});
