// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callStore, IDLE_CALL, updateCall } from "@/voice/call-store.js";
import { currentBindings } from "@/voice/bindings.js";
import { COMPOSER_MARKER } from "@/app/pointer-ghost/model.js";

const engine = vi.hoisted(() => ({ toggleMute: vi.fn(async () => undefined), stopCall: vi.fn(async () => undefined) }));
vi.mock("@/voice/engine.js", () => engine);

const { ComposerCallControls, dotState, formatElapsed } = await import("./composer-controls.js");

afterEach(() => {
  callStore.set(IDLE_CALL);
  engine.toggleMute.mockClear();
  engine.stopCall.mockClear();
});

describe("composer call controls", () => {
  it("formats elapsed time as m:ss, then h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_400)).toBe("1:05");
    expect(formatElapsed(3_600_000 + 61_000)).toBe("1:01:01");
  });

  it("shows a paused dot while the microphone is suspended", () => {
    expect(dotState({ activity: "agent", micSuspended: true })).toBe("paused");
    expect(dotState({ activity: "you", micSuspended: false })).toBe("you");
  });

  it("draws nothing while idle but registers the composer bindings", () => {
    const strip = renderSlot({ component: ComposerCallControls }, {}, { composer: { text: "hello", scope: { kind: "thread", threadId: "t1" } } });
    try {
      expect(strip.container.querySelector(`[${COMPOSER_MARKER}]`)?.textContent).toBe("");
      const bindings = currentBindings();
      expect(bindings?.kind).toBe("composer");
      expect(bindings?.context()).toEqual({ threadId: "t1", projectId: null, onNewThreadScreen: false });
      expect(bindings?.composer?.draft().text).toBe("hello");
    } finally {
      strip.unmount();
    }
    expect(currentBindings()?.kind).not.toBe("composer");
  });

  it("knows the new thread screen from the composer scope", () => {
    const strip = renderSlot({ component: ComposerCallControls }, {}, { composer: { scope: { kind: "new-thread", projectId: "p1" } } });
    try {
      expect(currentBindings()?.context()).toEqual({ threadId: null, projectId: "p1", onNewThreadScreen: true });
    } finally {
      strip.unmount();
    }
  });

  it("shows time, activity, and labelled Mute and Stop while live", async () => {
    updateCall({ state: "live", owner: "self", startedAt: Date.now() - 65_000, activity: "agent" });
    const strip = renderSlot({ component: ComposerCallControls }, {});
    try {
      expect(strip.getByLabelText("Elapsed time").textContent).toBe("1:05");
      expect(strip.getByLabelText("Juno is speaking").getAttribute("data-activity")).toBe("agent");
      expect(strip.container.querySelector(".dispatch-wave")?.hasAttribute("data-speaking")).toBe(true);
      fireEvent.click(strip.getByLabelText("Mute Juno's microphone"));
      fireEvent.click(strip.getByLabelText("Stop Juno"));
      expect(engine.toggleMute).toHaveBeenCalledTimes(1);
      expect(engine.stopCall).toHaveBeenCalledTimes(1);
      await act(async () => updateCall({ state: "muted", activity: "idle" }));
      expect(strip.getByLabelText("Unmute Juno's microphone").getAttribute("aria-pressed")).toBe("true");
      expect(strip.container.querySelector(".dispatch-wave")?.hasAttribute("data-speaking")).toBe(false);
    } finally {
      strip.unmount();
    }
  });
});
