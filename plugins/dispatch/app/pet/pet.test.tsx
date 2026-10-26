// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPreferences } from "@/shared/constants.js";
import type { LiveStatus, SetupStatus } from "@/shared/contract.js";
import { phoneAttempt } from "@/app/phone-status.js";
import { ConsoleStatusOverlay } from "@/app/console/presence.js";
import { callStore, IDLE_CALL, updateCall } from "@/voice/call-store.js";
import { prefsStore, setupStore } from "@/voice/preferences.js";
import { DEFAULT_PET_LOOK } from "./look.js";

const engine = vi.hoisted(() => ({ toggleCall: vi.fn(async () => undefined), callMyPhone: vi.fn(async () => null) }));
vi.mock("@/voice/engine.js", () => engine);

import { Pet, PetIcon, FooterControls, usePetFace } from "./pet.js";

type Avatar = HTMLElement & {
  _sleeping?: boolean;
  _state?: string;
  getHeadRoundness(): number;
  startWaiting(options?: { variant?: string }): Promise<unknown>;
};

/** Move the fake clock. Tests that wait call vi.useFakeTimers() before they render. */
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const avatarIn = (root: HTMLElement) => root.querySelector("agent-robot-avatar") as Avatar;
const lookStyle = (avatar: Avatar) => avatar.shadowRoot?.querySelector("style[data-dispatch-look]")?.textContent ?? "";


function setup(phoneReady: boolean): SetupStatus {
  return {
    fields: {} as SetupStatus["fields"],
    voice: { ready: true, missing: [] },
    phone: { ready: phoneReady, missing: phoneReady ? [] : ["Twilio account"], webhooksPlugin: "present" },
    needsConfiguration: false,
    reloadPending: false,
    version: "test",
  };
}


afterEach(() => {
  vi.useRealTimers();
  callStore.set(IDLE_CALL);
  phoneAttempt.set(null);
  prefsStore.set(defaultPreferences());
  setupStore.set(null);
  engine.toggleCall.mockClear();
  engine.callMyPhone.mockClear();
});

describe("footer pet", () => {
  it("labels the footer without starting a call", () => {
    const icon = renderSlot({ component: PetIcon }, {});
    try {
      expect(icon.container.querySelector("[data-dispatch-pet]")?.getAttribute("aria-label")).toBe("Juno · asleep");
      expect(engine.toggleCall).not.toHaveBeenCalled();
      expect(engine.callMyPhone).not.toHaveBeenCalled();
    } finally {
      icon.unmount();
    }
  });

  it("sleeps with no call, ignores clicks, and draws an outline", async () => {
    vi.useFakeTimers();
    const icon = renderSlot({ component: Pet }, { face: "sleep" });
    try {
      const avatar = avatarIn(icon.container);
      expect(typeof (avatar as { sleep?: unknown }).sleep).toBe("function");
      // Clicks belong to BB's footer disclosure button.
      expect(avatar.getAttribute("wake-on")).toBe("manual");
      expect(lookStyle(avatar)).toMatch(/stroke: currentColor/);
      // The ring sits last in the head group, above the eyelids.
      const ring = avatar.shadowRoot?.getElementById("dispatchRing");
      expect(ring?.parentElement?.id).toBe("headMotion");
      expect(ring?.parentElement?.lastElementChild).toBe(ring);
      expect(lookStyle(avatar)).toMatch(/#antennaDot \{ fill: currentColor/);
      await wait(2600);
      expect(avatar._sleeping).toBe(true);
    } finally {
      icon.unmount();
    }
  });

  it("leaves right-click to the host without starting a call", () => {
    const nativeMenu = vi.fn();
    const icon = renderSlot({ component: () => (
      <div onContextMenu={(event) => { expect(event.defaultPrevented).toBe(false); nativeMenu(); }}>
        <PetIcon />
      </div>
    ) }, {});
    try {
      fireEvent.contextMenu(icon.container.querySelector("[data-dispatch-pet]")!);
      expect(nativeMenu).toHaveBeenCalledTimes(1);
      expect(icon.container.querySelector("[role=menu]")).toBeNull();
      expect(engine.toggleCall).not.toHaveBeenCalled();
      expect(engine.callMyPhone).not.toHaveBeenCalled();
    } finally {
      icon.unmount();
    }
  });

  it("keeps phone calls disabled until setup is ready, and while dialing", async () => {
    setupStore.set(setup(false));
    const dismiss = vi.fn();
    const controls = renderSlot({ component: () => <><ConsoleStatusOverlay /><FooterControls dismiss={dismiss} /></> }, {}, {
      rpc: { liveStatus: async () => ({ live: false, channel: null, startedAt: null, device: null }) },
    });
    try {
      await act(async () => {});
      const buttons = controls.container.querySelectorAll("button");
      const phone = buttons[1]!;
      expect(phone.disabled).toBe(true);
      fireEvent.click(phone);
      expect(dismiss).not.toHaveBeenCalled();
      expect(engine.callMyPhone).not.toHaveBeenCalled();
      await act(async () => setupStore.set(setup(true)));
      expect(phone.disabled).toBe(false);
      await act(async () => phoneAttempt.set({ phase: "dialing", at: Date.now() }));
      expect(phone.disabled).toBe(true);
      expect(engine.toggleCall).not.toHaveBeenCalled();
      expect(engine.callMyPhone).not.toHaveBeenCalled();
    } finally {
      controls.unmount();
    }
  });

  it("shows phone waiting and live moods with an accessible status, then sleeps when the call ends", async () => {
    let status: LiveStatus = { live: false, channel: null, startedAt: null, device: null };
    const icon = renderSlot({ component: () => <><ConsoleStatusOverlay /><PetIcon /></> }, {}, { rpc: { liveStatus: async () => status } });
    try {
      await act(async () => {});
      await act(async () => phoneAttempt.set({ phase: "dialing", at: Date.now() }));
      expect(icon.container.querySelector(".dispatch-pet")?.getAttribute("data-mood")).toBe("work");
      expect(icon.container.querySelector("[role=img]")?.getAttribute("aria-label")).toContain("Calling your phone…");
      await act(async () => phoneAttempt.set({ phase: "ringing", at: Date.now() }));
      expect(icon.container.querySelector("[title]")?.getAttribute("title")).toContain("Waiting for you to answer…");
      expect(icon.container.querySelector('[role="status"]')?.textContent).toBe("Dispatch: Waiting for you to answer…");
      const at = Date.now();
      status = { live: true, channel: "phone", startedAt: at - 65_000, device: null };
      await icon.emitRealtime("trace-tail", { callId: "phone", events: [{ id: 1, callId: "phone", kind: "call.started", at, payload: { channel: "phone" } }] });
      await act(async () => {});
      expect(icon.container.querySelector(".dispatch-pet")?.getAttribute("data-mood")).toBe("awake");
      expect(icon.container.querySelector("[role=img]")?.getAttribute("aria-label")).toMatch(/Phone call live · 1:0\d/);
      status = { live: false, channel: null, startedAt: null, device: null };
      await icon.emitRealtime("trace-tail", { callId: "phone", events: [{ id: 2, callId: "phone", kind: "call.closed", at: at + 1, payload: null }] });
      await act(async () => {});
      expect(icon.container.querySelector(".dispatch-pet")?.getAttribute("data-mood")).toBe("sleep");
      expect(icon.container.querySelector("[role=img]")?.getAttribute("aria-label")).toContain("Call ended");
    } finally {
      icon.unmount();
    }
  });

  it("draws the saved look and follows a change", async () => {
    const icon = renderSlot({ component: PetIcon }, {});
    try {
      const avatar = avatarIn(icon.container);
      const span = icon.container.querySelector(".dispatch-pet") as HTMLElement;
      expect(span.style.color).toBe("");
      await act(async () =>
        prefsStore.set({ ...defaultPreferences(), pet: { ...DEFAULT_PET_LOOK, style: "solid", color: "#ef4444", roundness: 90 } }),
      );
      expect(span.style.color).toBe("rgb(239, 68, 68)");
      expect(avatar.shadowRoot?.querySelectorAll("style[data-dispatch-look]").length).toBe(1);
      expect(lookStyle(avatar)).not.toMatch(/stroke/);
      expect(avatar.getHeadRoundness()).toBe(90);
    } finally {
      icon.unmount();
    }
  });

  it("a preview pet uses the look it is given, not the saved one", () => {
    const preview = renderSlot({ component: Pet }, { face: "awake", look: { ...DEFAULT_PET_LOOK, color: "#3b82f6" } });
    try {
      expect((preview.container.querySelector(".dispatch-pet") as HTMLElement).style.color).toBe("rgb(59, 130, 246)");
    } finally {
      preview.unmount();
    }
  });

  it("listening shows the text cursor and lingers through a pause in speech", async () => {
    vi.useFakeTimers();
    updateCall({ state: "live", owner: "self", startedAt: Date.now(), activity: "you" });
    const pet = renderSlot({ component: () => <Pet face={usePetFace()} /> }, {});
    try {
      const avatar = avatarIn(pet.container);
      expect(avatar.getAttribute("data-mood")).toBe("listen");
      expect(lookStyle(avatar)).toMatch(/opacity="0\.000"/);
      await wait(500);
      expect(avatar._state).toBe("input");
      await act(async () => updateCall({ activity: "idle" }));
      await wait(200);
      expect(avatar.getAttribute("data-mood")).toBe("listen");
      await wait(500);
      expect(avatar.getAttribute("data-mood")).toBe("awake");
      expect(avatar._state).not.toBe("input");
    } finally {
      pet.unmount();
    }
  });

  it("working alternates the two waiting loops and stops when the face changes", async () => {
    vi.useFakeTimers();
    const pet = renderSlot({ component: Pet }, { face: "work" });
    const avatar = avatarIn(pet.container);
    const variants: string[] = [];
    const startWaiting = avatar.startWaiting.bind(avatar);
    avatar.startWaiting = (options) => {
      variants.push(options?.variant ?? "default");
      return startWaiting(options);
    };
    try {
      // The first loop began on mount, before the spy.
      await wait(3400);
      expect(variants).toEqual(["wrap"]);
      pet.rerender(createElement(Pet, { face: "awake" }));
      await wait(3000);
      expect(variants).toEqual(["wrap"]);
    } finally {
      pet.unmount();
    }
  });
});
