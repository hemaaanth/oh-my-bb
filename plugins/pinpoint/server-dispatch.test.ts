// Server-level dispatch coverage under the SDK fake host:
//   * picker-anchored captures advertise the screenshot on the FIRST dispatch
//     even though the picker's upload is still in flight (finding: presence-
//     based advertising raced the async upload);
//   * a reply saved while a send is in flight (routing "sending") is re-staged
//     and dispatched exactly once after the in-flight send settles;
//   * a row deleted while its send is in flight neither crashes dispatch nor
//     resurrects state;
//   * the /screenshot route binds uploads to the capture's page (403 on url
//     mismatch) — the authorization checks themselves live in lib/store.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import plugin, { type PinpointAnnotation } from "./server";

type CaptureOutput = { row: PinpointAnnotation; dispatched: boolean };
type UpdateOutput = { row: PinpointAnnotation; warning?: string };
type ListOutput = { rows: PinpointAnnotation[] };

type SendArgs = {
  threadId: string;
  input: {
    type: string;
    text?: string;
    visibility?: "agent-only";
    mentions?: never[];
  }[];
};

async function makeHost(options?: {
  settings?: Record<string, unknown>;
  agents?: boolean;
  get?: () => Promise<{ projectId: string; environmentId: string | null }>;
  send?: (args: SendArgs) => Promise<unknown>;
  spawn?: () => Promise<{
    id: string;
    projectId: string;
    environmentId: string | null;
  }>;
  plugins?: {
    callRpc(args: {
      pluginId: string;
      method: string;
      input: unknown;
    }): Promise<unknown>;
  };
}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "pinpoint",
    settings: options?.settings,
    sdk: {
      threads: {
        get:
          options?.get ??
          (async () => ({ projectId: "project-test", environmentId: null })),
        send: options?.send ?? (async () => ({})),
        ...(options?.spawn ? { spawn: options.spawn } : {}),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          gitRemoteUrl: null,
        }),
      },
      ...(options?.plugins ? { plugins: options.plugins } : {}),
    },
  });
  await plugin(bb);
  if (options?.agents) await harness.behavior.callRpc("setIntegration", { integration: "agents", enabled: true });
  return harness;
}

const CAPTURE = {
  threadId: "thread-1",
  url: "http://localhost:3000/pricing",
  comment: "align the buttons",
  selector: "div > p:nth-of-type(2) > button",
  element: "button",
  elementPath: "div > p:nth-of-type(2) > button",
  reactComponents: "Button",
};

describe("Pinpoint dispatch through the live server wiring", () => {
  it("dispatches through BB alone when optional integrations are disabled", async () => {
    const sends: SendArgs[] = [];
    const harness = await makeHost({
      get: async () => ({ projectId: "project-test", environmentId: "environment-test" }),
      spawn: async () => ({ id: "native-child", projectId: "project-test", environmentId: "environment-test" }),
      plugins: { callRpc: async () => { throw new Error("No optional plugin may be contacted"); } },
      send: async (args) => { sends.push(args); return {}; },
    });
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    const result = await harness.behavior.callRpc("capture", CAPTURE) as CaptureOutput;
    expect(result.dispatched).toBe(true);
    expect(sends.map((send) => send.threadId)).toEqual(["native-child"]);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });

  it("routes visual and text-edit feedback through their saved agent profiles", async () => {
    const profileRoles: string[] = [];
    const sends: SendArgs[] = [];
    const harness = await makeHost({
      settings: { relayMode: "review-chat" },
      agents: true,
      get: async () => ({
        projectId: "project-test",
        environmentId: "environment-test",
      }),
      plugins: {
        async callRpc({ pluginId, method, input }) {
          expect(pluginId).toBe("agent-profiles");
          expect(method).toBe("spawnBuiltInProfile");
          if (
            !input ||
            typeof input !== "object" ||
            !("profile" in input) ||
            typeof input.profile !== "string"
          ) {
            throw new Error("Invalid built-in profile request");
          }
          profileRoles.push(input.profile);
          return {
            threadId: `child-${input.profile}`,
            environmentId: "environment-test",
            profileId: "00000000-0000-4000-8000-000000000001",
            revision: 1,
          };
        },
      },
      send: async (args) => {
        sends.push(args);
        return {};
      },
    });

    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_visualagent",
    });
    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_textagent",
      kind: "text-edit",
      textOld: "Old copy",
      textNew: "New copy",
    });

    expect(profileRoles).toEqual(["pinpoint-review", "text-edit"]);
    expect(sends.map((send) => send.threadId)).toEqual([
      "child-pinpoint-review",
      "child-text-edit",
    ]);
    expect(sends[0]!.input[0]).toMatchObject({
      visibility: "agent-only",
      text: expect.stringContaining(
        "- selector: `div > p:nth-of-type(2) > button`",
      ),
    });
    expect(sends[0]!.input[1]).toEqual({
      type: "text",
      text: "`Button` align the buttons",
      mentions: [],
    });
    expect(sends[1]!.input[0]!.text).not.toContain("pinpoint_show");
    expect(sends[1]!.input.some((part) => part.type === "localImage")).toBe(
      false,
    );
  });

  it("retries a saved profile after using a temporary fallback child", async () => {
    let profileAttempts = 0;
    const sends: SendArgs[] = [];
    const harness = await makeHost({
      settings: { relayMode: "review-chat" },
      agents: true,
      get: async () => ({
        projectId: "project-test",
        environmentId: "environment-test",
      }),
      spawn: async () => ({
        id: "fallback-child",
        projectId: "project-test",
        environmentId: "environment-test",
      }),
      plugins: {
        async callRpc() {
          profileAttempts += 1;
          if (profileAttempts === 1) throw new Error("Agents unavailable");
          return {
            threadId: "profile-child",
            environmentId: "environment-test",
            profileId: "00000000-0000-4000-8000-000000000001",
            revision: 1,
          };
        },
      },
      send: async (args) => {
        sends.push(args);
        return {};
      },
    });

    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_fallbackone",
    });
    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_profiletwo",
    });

    expect(profileAttempts).toBe(2);
    expect(sends.map((send) => send.threadId)).toEqual([
      "fallback-child",
      "profile-child",
    ]);
  });

  it("retries a transient thread-starting conflict instead of stranding the first pin", async () => {
    let attempts = 0;
    const harness = await makeHost({
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("HTTP 409: Thread is still starting");
        }
        return {};
      },
    });

    const out = (await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_startretry1",
    })) as CaptureOutput;

    expect(attempts).toBe(2);
    expect(out.dispatched).toBe(true);
    expect(out.row.workflowState).toBe("dispatched");
    expect(out.row.routing.lastError).toBeNull();
  });

  it("stops after the bounded thread-starting retries and records the failure once", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const harness = await makeHost({
        send: async () => {
          attempts += 1;
          throw new Error("HTTP 409: Thread is still starting");
        },
      });

      const capture = harness.behavior.callRpc("capture", {
        ...CAPTURE,
        clientId: "pp_startretry2",
      }) as Promise<CaptureOutput>;
      await vi.runAllTimersAsync();
      const out = await capture;

      expect(attempts).toBe(6);
      expect(out.dispatched).toBe(false);
      expect(out.row.workflowState).toBe("open");
      expect(out.row.routing.lastError).toContain("Thread is still starting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry unrelated conflicts", async () => {
    let attempts = 0;
    const harness = await makeHost({
      send: async () => {
        attempts += 1;
        throw new Error("HTTP 409: Annotation already exists");
      },
    });

    const out = (await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_startretry3",
    })) as CaptureOutput;

    expect(attempts).toBe(1);
    expect(out.dispatched).toBe(false);
    expect(out.row.routing.lastError).toContain("Annotation already exists");
  });

  it("advertises the screenshot on the first dispatch of an anchored capture (upload still in flight)", async () => {
    const sent: string[] = [];
    const harness = await makeHost({
      send: async (args) => {
        sent.push(args.input[0]!.text ?? "");
        return {};
      },
    });

    // Picker-originated: the client id is adopted, no screenshot stored yet.
    const anchored = (await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_anchored1",
    })) as CaptureOutput;
    expect(anchored.dispatched).toBe(true);
    expect(sent[0]).toContain("pinpoint_show");
    expect(sent[0]).toContain("may still be in flight");

    // Non-anchored (no clientId): presence-based — no stored screenshot, no
    // pinpoint_show line.
    const plain = (await harness.behavior.callRpc(
      "capture",
      CAPTURE,
    )) as CaptureOutput;
    expect(plain.dispatched).toBe(true);
    expect(sent[1]).not.toContain("pinpoint_show");
  });

  it("does not advertise a screenshot when the reviewer disabled capture", async () => {
    const sent: string[] = [];
    const harness = await makeHost({
      send: async (input) => {
        sent.push(JSON.stringify(input));
        return {};
      },
    });

    const out = (await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_noscreenshot1",
      screenshotExpected: false,
    })) as CaptureOutput;

    expect(out.dispatched).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("pinpoint_show");
    expect(sent[0]).not.toContain("- screenshot:");
  });

  it("dispatches a reply that arrived during an in-flight send exactly once after it settles", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const sends: SendArgs[] = [];
    let first = true;
    const harness = await makeHost({
      send: async (args) => {
        sends.push(args);
        if (first) {
          first = false;
          await firstGate; // hold the FIRST dispatch in flight
        }
        return {};
      },
    });

    const id = "pp_pending1";
    const capturePromise = harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: id,
    }) as Promise<CaptureOutput>;
    await vi.waitFor(() => expect(sends.length).toBe(1));

    // Reply while the send is in flight: the claim is busy, the note is kept.
    const updated = (await harness.behavior.callRpc("update", {
      id,
      action: "feedback",
      note: "Also fix the padding",
    })) as UpdateOutput;
    expect(updated.warning).toContain("still being delivered");

    // The in-flight send settles → the pending reply is dispatched once.
    releaseFirst();
    const captured = await capturePromise;
    expect(captured.dispatched).toBe(true);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.input[0]!.text).toContain("(follow-up)");
    expect(sends[1]!.input[0]!.text).toContain("Also fix the padding");
    expect(sends[1]!.threadId).toBe(sends[0]!.threadId);

    // The flag was cleared BEFORE the follow-up dispatch — no loop, and the
    // item is back to a clean dispatched state.
    const listed = (await harness.behavior.callRpc("list", {
      threadId: "thread-1",
    })) as ListOutput;
    const row = listed.rows.find((r) => r.annotation.id === id)!;
    expect(row.workflowState).toBe("dispatched");
    expect(
      (row.annotation.pinpoint as { pendingFollowUp?: boolean })
        .pendingFollowUp,
    ).toBeUndefined();
    // Nothing else went out after the single follow-up.
    expect(sends).toHaveLength(2);
  });

  it("includes a newer reply that lands while an assigned thread is being checked", async () => {
    let blockGets = false;
    let blockedGets = 0;
    let releaseGets!: () => void;
    const getGate = new Promise<void>((resolve) => (releaseGets = resolve));
    const sends: SendArgs[] = [];
    const harness = await makeHost({
      get: async () => {
        if (blockGets) {
          blockedGets += 1;
          await getGate;
        }
        return { projectId: "project-test", environmentId: null };
      },
      send: async (args) => {
        sends.push(args);
        return {};
      },
    });
    const id = "pp_preclaim1";
    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: id,
    });

    blockGets = true;
    const first = harness.behavior.callRpc("update", {
      id,
      action: "feedback",
      note: "First follow-up",
    }) as Promise<UpdateOutput>;
    await vi.waitFor(() => expect(blockedGets).toBe(1));
    const second = harness.behavior.callRpc("update", {
      id,
      action: "feedback",
      note: "Newer follow-up",
    }) as Promise<UpdateOutput>;
    await vi.waitFor(() => expect(blockedGets).toBe(2));
    releaseGets();
    await Promise.all([first, second]);

    expect(sends).toHaveLength(2);
    expect(sends[1]!.input[0]!.text).toContain("First follow-up");
    expect(sends[1]!.input[0]!.text).toContain("Newer follow-up");
  });

  it("does not retry a startup conflict after the pin was deleted", async () => {
    let releaseOriginal!: () => void;
    const originalGate = new Promise<void>((resolve) => (releaseOriginal = resolve));
    let originalAttempts = 0;
    const id = "pp_delretry1";
    const harness = await makeHost({
      send: async (args) => {
        const text = args.input[0]!.text ?? "";
        if (text.includes("was deleted by the user")) return {};
        originalAttempts += 1;
        await originalGate;
        throw new Error("HTTP 409: Thread is still starting");
      },
    });
    const capture = harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: id,
    }) as Promise<CaptureOutput>;
    await vi.waitFor(() => expect(originalAttempts).toBe(1));

    await harness.behavior.callRpc("remove", { id });
    releaseOriginal();
    const out = await capture;

    expect(out.dispatched).toBe(false);
    expect(originalAttempts).toBe(1);
  });

  it("survives a row deleted mid-send when the send then throws (no crash, no resurrection)", async () => {
    const id = "pp_delthrow1";
    let harnessRef: Awaited<ReturnType<typeof makeHost>>;
    const harness = await makeHost({
      send: async (args) => {
        const text = args.input[0]!.text ?? "";
        // The deletion path's cancellation note must go through normally.
        if (text.includes("was deleted by the user")) return {};
        await harnessRef.behavior.callRpc("remove", { id });
        throw new Error("send exploded");
      },
    });
    harnessRef = harness;

    const out = (await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: id,
    })) as CaptureOutput;

    expect(out.dispatched).toBe(false);
    const listed = (await harness.behavior.callRpc("list", {
      threadId: "thread-1",
    })) as ListOutput;
    expect(listed.rows).toHaveLength(0);
  });

  it("survives a row deleted mid-send when the send then succeeds", async () => {
    const id = "pp_delok1";
    let harnessRef: Awaited<ReturnType<typeof makeHost>>;
    const harness = await makeHost({
      send: async (args) => {
        const text = args.input[0]!.text ?? "";
        if (text.includes("was deleted by the user")) return {};
        await harnessRef.behavior.callRpc("remove", { id });
        return {};
      },
    });
    harnessRef = harness;

    const out = (await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: id,
    })) as CaptureOutput;

    // The routing claim vanished with the row, so the dispatch reports
    // failure — but nothing throws and nothing is resurrected.
    expect(out.dispatched).toBe(false);
    const listed = (await harness.behavior.callRpc("list", {
      threadId: "thread-1",
    })) as ListOutput;
    expect(listed.rows).toHaveLength(0);
  });
});

describe("Pinpoint text-edit screenshot policy", () => {
  it("rejects and hides screenshots for text edits", async () => {
    const harness = await makeHost({ settings: { autoDispatch: false } });
    const id = "pp_textshot1";
    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: id,
      kind: "text-edit",
      textOld: "Old copy",
      textNew: "New copy",
      screenshotExpected: true,
    });

    await expect(harness.behavior.callRpc("uploadScreenshot", {
      threadId: CAPTURE.threadId, clientId: id, kind: "element",
      mime: "image/webp", screenshot: "dGVzdA==", url: CAPTURE.url,
    })).rejects.toThrow();
    expect(
      await harness.behavior.callRpc("screenshot", {
        id,
        kind: "element",
      }),
    ).toEqual({ shot: null });

    const listed = (await harness.behavior.callRpc("list", {
      threadId: "thread-1",
    })) as ListOutput;
    expect(listed.rows[0]!.screenshots).toEqual([]);
  });
});
