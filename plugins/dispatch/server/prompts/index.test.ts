import { describe, expect, it } from "vitest";
import { APP_CONTEXT, DESKTOP_DEVICE, PHONE_CONTEXT, loadPlugin, makeContext, pluginRow } from "../core-test-host.js";
import { writeFromSettings } from "../instructions.js";
import { writePreferences } from "../preferences.js";
import { NAME_SLOT, RUNTIME_HEADING, YOURS_HEADING } from "./built-in.js";
import { NO_INSTRUCTIONS, PART_SEPARATOR, assemblePrompts, buildRuntimeContext } from "./index.js";

const NOW = new Date(2026, 9, 19, 14, 5);

describe("prompt assembly", () => {
  it("fills the agent name into both prompts", async () => {
    const { ctx } = await makeContext();
    await writePreferences(ctx, { agentName: "Ivy" });
    const prompts = await assemblePrompts(ctx, { context: APP_CONTEXT, now: NOW });
    for (const parts of [prompts.voice, prompts.backend]) {
      expect(parts.builtIn).not.toContain(NAME_SLOT);
      expect(parts.builtIn).toContain("Ivy");
      expect(parts.runtime).toContain("- Your name: Ivy.");
    }
  });

  it("puts Your instructions last, and the parts join to the assembled text", async () => {
    const { ctx } = await makeContext();
    writeFromSettings(ctx, "Call me Sam.");
    const prompts = await assemblePrompts(ctx, { context: APP_CONTEXT, device: DESKTOP_DEVICE, now: NOW });
    for (const parts of [prompts.voice, prompts.backend]) {
      expect(parts.assembled).toBe([parts.builtIn, parts.runtime, parts.yours].join(PART_SEPARATOR));
      expect(parts.assembled.endsWith(`${YOURS_HEADING}\n\nCall me Sam.`)).toBe(true);
      expect(parts.assembled.lastIndexOf(YOURS_HEADING)).toBeGreaterThan(parts.assembled.indexOf(RUNTIME_HEADING));
    }
  });

  it("says so when there are no instructions yet", async () => {
    const { ctx } = await makeContext();
    const prompts = await assemblePrompts(ctx, { context: APP_CONTEXT, now: NOW });
    expect(prompts.voice.yours).toBe(`${YOURS_HEADING}\n\n${NO_INSTRUCTIONS}`);
  });

  it("lists only the plugins the agent may run", async () => {
    const plugins = { plugins: { list: async () => ({ plugins: [pluginRow(), pluginRow({ id: "todo", name: "Todo", cliCommand: { name: "todo", summary: "" } })] }) } };
    const { ctx } = await makeContext(undefined, plugins);
    await writePreferences(ctx, { pluginAccess: { mode: "selected", ids: ["todo"] } });
    const { voice } = await assemblePrompts(ctx, { context: APP_CONTEXT, now: NOW });
    expect(voice.runtime).toContain("Todo (todo): bb todo");
    expect(voice.runtime).not.toContain("Notes (notes)");
  });

  it("describes the thread on screen and the phone", () => {
    const base = { agentName: "Juno", plugins: [], now: NOW };
    const app = buildRuntimeContext({
      ...base,
      context: { ...APP_CONTEXT, threadId: "thr_a" },
      device: DESKTOP_DEVICE,
      thread: { title: "Fix the header", status: "active" },
      projectName: "Website",
    });
    expect(app).toContain('- Screen: the thread "Fix the header" (active) in the project Website. Its id is thr_a.');
    expect(app).toContain("Chrome on Mac, a computer in the BB app");
    const phone = buildRuntimeContext({ ...base, context: PHONE_CONTEXT });
    expect(phone).toContain("a phone call");
    expect(phone).toContain("- Plugin commands: none are allowed on this call.");
  });

  it("serves promptPreview from the same assembly", async () => {
    const { harness } = await loadPlugin();
    const preview = (await harness.callRpc("promptPreview", {})) as { voice: { builtIn: string; runtime: string; yours: string; assembled: string } };
    expect(preview.voice.assembled).toBe([preview.voice.builtIn, preview.voice.runtime, preview.voice.yours].join(PART_SEPARATOR));
  });
});
