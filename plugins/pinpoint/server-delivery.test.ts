// Delivery guarantees around the relay child, under the SDK fake host.
//
// The failure these cover, observed live: the saved Pinpoint Review profile is
// pinned to a provider whose account was out of quota, so every pin sent to its
// child thread died on a usage limit. The thread stayed idle and valid, the
// send resolved, the turn recorded itself as completed, and the item sat
// "dispatched" forever — while the parent agent, seeing the child finish with
// nothing, quietly did the work itself.
//
//   * pre-flight: a profile whose account is exhausted never gets spawned;
//   * verification: a child that accepts a pin and does no work loses it;
//   * state: "acknowledged" waits for the agent, it is not a receipt for send.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import plugin, { type PinpointAnnotation } from "./server";

type ListOutput = { rows: PinpointAnnotation[] };
type SendArgs = { threadId: string; input: unknown[] };
type EventRow = { seq: number; type: string; data?: unknown };

const CAPTURE = {
  threadId: "thread-1",
  url: "http://localhost:3000/pricing",
  comment: "align the buttons",
  selector: "div > p:nth-of-type(2) > button",
  element: "button",
  elementPath: "div > p:nth-of-type(2) > button",
  reactComponents: "Button",
};

const REVIEW_PROFILE = {
  slug: "pinpoint-review",
  providerId: "acp-omp",
  model: "openai-codex/gpt-5.6-sol",
};

function usage(usedPercent: number) {
  return {
    machines: [
      {
        id: "host-1",
        status: "connected" as const,
        providers: [
          {
            id: "codex",
            displayName: "Codex",
            usage: {
              status: "ok" as const,
              windows: [
                {
                  label: "Weekly limit",
                  usedPercent,
                  resetsAt: "2026-09-16T13:50:36.000Z",
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** A completed turn that changed nothing — the rate-limited child's shape. */
function stalledEvents(): EventRow[] {
  return [
    { seq: 1, type: "turn/started" },
    {
      seq: 2,
      type: "item/completed",
      data: {
        item: {
          type: "agentMessage",
          text: "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
        },
      },
    },
    { seq: 3, type: "turn/completed" },
  ];
}

function productiveEvents(): EventRow[] {
  return [
    { seq: 1, type: "turn/started" },
    { seq: 2, type: "item/completed", data: { item: { type: "fileChange" } } },
    {
      seq: 3,
      type: "item/completed",
      data: { item: { type: "agentMessage", text: "Done." } },
    },
    { seq: 4, type: "turn/completed" },
  ];
}

async function makeHost(options: {
  spawnProfile?: () => unknown;
  spawn?: () => Promise<{
    id: string;
    projectId: string;
    environmentId: string | null;
  }>;
  usedPercent?: number;
  eventsByThread?: Record<string, EventRow[]>;
  sends: SendArgs[];
  profileSpawns?: string[];
  relayMode?: "thread" | "review-chat";
}) {
  const events = options.eventsByThread ?? {};
  const { bb, harness } = createFakePluginHost({
    pluginId: "pinpoint",
    settings: { relayMode: options.relayMode ?? "review-chat" },
    sdk: {
      threads: {
        get: async () => ({
          projectId: "project-test",
          environmentId: "environment-test",
        }),
        send: async (args: SendArgs) => {
          options.sends.push(args);
          return {};
        },
        ...(options.spawn ? { spawn: options.spawn } : {}),
        events: {
          list: async ({
            threadId,
            order,
          }: {
            threadId: string;
            order?: string;
          }) => {
            const rows = events[threadId] ?? [];
            return order === "desc" ? [...rows].reverse() : rows;
          },
          wait: async ({ threadId }: { threadId: string }) =>
            (events[threadId] ?? []).find(
              (row) => row.type === "turn/completed",
            ) ?? null,
        },
      },
      environments: {
        get: async () => ({ id: "environment-test", hostId: "host-1" }),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          gitRemoteUrl: null,
        }),
      },
      plugins: {
        async callRpc({
          pluginId,
          method,
          input,
        }: {
          pluginId: string;
          method: string;
          input: unknown;
        }) {
          if (pluginId === "agent-profiles" && method === "listProfiles") {
            return [REVIEW_PROFILE];
          }
          if (pluginId === "provider-usage" && method === "getUsage") {
            return usage(options.usedPercent ?? 10);
          }
          if (
            pluginId === "agent-profiles" &&
            method === "spawnBuiltInProfile"
          ) {
            const profile = (input as { profile: string }).profile;
            options.profileSpawns?.push(profile);
            return (
              options.spawnProfile?.() ?? {
                threadId: `child-${profile}`,
                environmentId: "environment-test",
                profileId: "00000000-0000-4000-8000-000000000001",
                revision: 1,
              }
            );
          }
          throw new Error(`unexpected rpc ${pluginId}.${method}`);
        },
      },
    },
  });
  await plugin(bb);
  await harness.behavior.callRpc("setIntegration", { integration: "agents", enabled: true });
  await harness.behavior.callRpc("setIntegration", { integration: "providerUsage", enabled: true });
  return harness;
}

async function rowFor(
  harness: Awaited<ReturnType<typeof makeHost>>,
): Promise<PinpointAnnotation> {
  const listed = (await harness.behavior.callRpc("list", {
    threadId: "thread-1",
  })) as ListOutput;
  return listed.rows[0]!;
}

describe("Pinpoint pre-flights the profile it is about to spawn", () => {
  it("skips a profile whose account is out of quota and uses a plain child", async () => {
    const sends: SendArgs[] = [];
    const profileSpawns: string[] = [];
    const harness = await makeHost({
      sends,
      profileSpawns,
      usedPercent: 100,
      spawn: async () => ({
        id: "fallback-child",
        projectId: "project-test",
        environmentId: "environment-test",
      }),
      eventsByThread: { "fallback-child": productiveEvents() },
    });

    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_exhausted",
    });

    // The whole point: no spawn into a provider that cannot run a turn, and
    // the work still goes to a child rather than back to the user's thread.
    expect(profileSpawns).toEqual([]);
    expect(sends.map((send) => send.threadId)).toEqual(["fallback-child"]);
  });

  it("spawns the profile normally when the account has quota left", async () => {
    const sends: SendArgs[] = [];
    const profileSpawns: string[] = [];
    const harness = await makeHost({
      sends,
      profileSpawns,
      usedPercent: 61,
      eventsByThread: { "child-pinpoint-review": productiveEvents() },
    });

    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_hasquota",
    });

    expect(profileSpawns).toEqual(["pinpoint-review"]);
    expect(sends.map((send) => send.threadId)).toEqual([
      "child-pinpoint-review",
    ]);
  });
});

describe("Pinpoint verifies that the relay child acted", () => {
  it("takes the item back from a child that accepted it and did nothing", async () => {
    const sends: SendArgs[] = [];
    let spawned = 0;
    const harness = await makeHost({
      sends,
      spawnProfile: () => {
        spawned += 1;
        return {
          threadId: `child-${spawned}`,
          environmentId: "environment-test",
          profileId: "00000000-0000-4000-8000-000000000001",
          revision: 1,
        };
      },
      eventsByThread: {
        "child-1": stalledEvents(),
        "child-2": productiveEvents(),
      },
    });

    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_stalledone",
    });

    // The first child stalls, so the item is re-dispatched to a fresh one.
    await vi.waitFor(async () => {
      expect(sends.map((send) => send.threadId)).toEqual([
        "child-1",
        "child-2",
      ]);
    });
    await vi.waitFor(async () => {
      const row = await rowFor(harness);
      expect(row.routing.assignedThreadId).toBe("child-2");
      expect(row.annotation.status).toBe("acknowledged");
    });
  });

  it("stops re-dispatching once a second child also does nothing", async () => {
    const sends: SendArgs[] = [];
    let spawned = 0;
    const harness = await makeHost({
      sends,
      spawnProfile: () => {
        spawned += 1;
        return {
          threadId: `child-${spawned}`,
          environmentId: "environment-test",
          profileId: "00000000-0000-4000-8000-000000000001",
          revision: 1,
        };
      },
      eventsByThread: {
        "child-1": stalledEvents(),
        "child-2": stalledEvents(),
      },
    });

    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_stalledtwo",
    });

    // One automatic recovery, then it stops: two sends, never a third.
    await vi.waitFor(() => {
      expect(sends.map((send) => send.threadId)).toEqual([
        "child-1",
        "child-2",
      ]);
    });
    await vi.waitFor(async () => {
      const row = await rowFor(harness);
      // Back in the queue, visibly, with the provider's own words attached —
      // rather than reading "dispatched" while nothing happens.
      expect(row.workflowState).toBe("open");
      expect(row.routing.assignedThreadId).toBeNull();
      expect(row.routing.lastError).toContain("usage limit has been reached");
      expect(row.annotation.status).toBe("pending");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toHaveLength(2);
  });
});

describe("Pinpoint acknowledgement tracks the agent, not the send", () => {
  it("acknowledges immediately when the target is the user's own thread", async () => {
    const sends: SendArgs[] = [];
    const harness = await makeHost({ sends, relayMode: "thread" });

    await harness.behavior.callRpc("capture", {
      ...CAPTURE,
      clientId: "pp_ownthread",
    });

    expect(sends.map((send) => send.threadId)).toEqual(["thread-1"]);
    const row = await rowFor(harness);
    expect(row.annotation.status).toBe("acknowledged");
    expect(row.workflowState).toBe("dispatched");
  });
});
