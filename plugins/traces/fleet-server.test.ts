import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerFleet } from "./fleet-server";

const secret = "unstructured-private-output-12345";

describe("fleet event detail boundary", () => {
  it("fetches one exact SDK event and hides all payload text until explicitly revealed", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "traces", sdk: { threads: { events: { list: async () => [{
      id: "evt_1", threadId: "thr_fixture", seq: 7, createdAt: 100,
      type: "item/completed", scope: { kind: "turn", turnId: "turn_1" },
      data: { item: { type: "toolCall", id: "item_1", tool: "fetch", arguments: { key: secret }, result: secret } },
    }] } } } });
    registerFleet(bb);
    const hidden = await harness.behavior.callRpc("traces_fleet_detail", { threadId: "thr_fixture", seq: 7, reveal: false });
    expect(JSON.stringify(hidden)).not.toContain(secret);
    expect(hidden).toMatchObject({ seq: 7, type: "item/completed", input: "[hidden; select Reveal sensitive data]", output: "[hidden; select Reveal sensitive data]" });
    const shown = await harness.behavior.callRpc("traces_fleet_detail", { threadId: "thr_fixture", seq: 7, reveal: true });
    expect(JSON.stringify(shown)).toContain(secret);
    expect(harness.inspection.sdk.callsTo("threads.events.list").map(([args]) => args)).toEqual([
      { threadId: "thr_fixture", afterSeq: "6", limit: "1" }, { threadId: "thr_fixture", afterSeq: "6", limit: "1" },
    ]);
    await harness.lifecycle.dispose();
  });
});
