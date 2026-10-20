import { describe, expect, it } from "vitest";
import { CHANNELS, INSTRUCTIONS_LIMIT } from "../shared/constants.js";
import { APP_CONTEXT, makeContext, published } from "./core-test-host.js";
import { currentInstructions, restoreRevision, revisionHistory, writeFromSettings } from "./instructions.js";
import { BUILT_IN_MARKER, NAME_SLOT, VOICE_HEADING } from "./prompts/built-in.js";
import { assemblePrompts } from "./prompts/index.js";
import { executeServerTool } from "./tools/index.js";

describe("Your instructions", () => {
  it("writes a revision and publishes it", async () => {
    const { ctx, harness } = await makeContext();
    const revision = writeFromSettings(ctx, "  Call me Sam.  ");
    expect(revision).toMatchObject({ author: "user", note: "edited in settings", body: "Call me Sam." });
    expect(currentInstructions(ctx)).toBe("Call me Sam.");
    expect(published(harness, CHANNELS.instructionsUpdated)).toEqual([revision]);
  });

  it("rejects a body over the limit", async () => {
    const { ctx } = await makeContext();
    expect(() => writeFromSettings(ctx, "a".repeat(INSTRUCTIONS_LIMIT))).not.toThrow();
    expect(() => writeFromSettings(ctx, "a".repeat(INSTRUCTIONS_LIMIT + 1))).toThrow(/at most 4,000 characters/);
    expect(revisionHistory(ctx)).toHaveLength(1);
  });

  it("restores an old revision as a new one", async () => {
    const { ctx } = await makeContext();
    const first = writeFromSettings(ctx, "First.");
    writeFromSettings(ctx, "Second.");
    const restored = restoreRevision(ctx, first.id);
    expect(restored.id).toBeGreaterThan(first.id);
    expect(restored).toMatchObject({ body: "First.", note: `restored revision ${first.id}` });
    expect(revisionHistory(ctx).map((revision) => revision.body)).toEqual(["First.", "Second.", "First."]);
    expect(() => restoreRevision(ctx, 999)).toThrow(/no instruction revision 999/);
  });

  it("update_instructions saves an agent revision and refuses the built-in heading", async () => {
    const { ctx } = await makeContext();
    const call = (instructions: string) =>
      executeServerTool(ctx, { callId: "none", name: "update_instructions", args: { instructions, reason: "asked" }, context: APP_CONTEXT });
    const saved = await call("Speak slowly.");
    expect(saved.status).toBe("success");
    expect(revisionHistory(ctx)[0]).toMatchObject({ author: "agent", note: "asked", body: "Speak slowly." });
    const refused = await call(`${VOICE_HEADING}\nBe louder.`);
    expect(refused.status).toBe("error");
    expect(refused.output).toMatch(/^Error: .*built-in prompt/);
    expect(currentInstructions(ctx)).toBe("Speak slowly.");
  });

  it("never stores the built-in prompt", async () => {
    const { ctx, bb } = await makeContext();
    writeFromSettings(ctx, "Keep answers short.");
    await assemblePrompts(ctx, { context: APP_CONTEXT });
    const rows = bb.storage.database().prepare("SELECT body FROM instruction_revisions").all() as Array<{ body: string }>;
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.body).not.toContain(NAME_SLOT);
      expect(row.body).not.toContain(BUILT_IN_MARKER);
    }
  });
});
