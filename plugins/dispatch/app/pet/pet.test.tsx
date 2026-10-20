// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultPreferences } from "@/shared/constants.js";
import type { SetupStatus } from "@/shared/contract.js";
import { callStore, IDLE_CALL, updateCall } from "@/voice/call-store.js";
import { prefsStore, setupStore } from "@/voice/preferences.js";
import { setSettingsFallback } from "@/voice/settings-opener.js";
import { DEFAULT_PET_LOOK } from "./look.js";

const engine = vi.hoisted(() => ({ toggleCall: vi.fn(async () => undefined), callMyPhone: vi.fn(async () => null) }));
vi.mock("@/voice/engine.js", () => engine);

const { MiniPet, Pet, PetIcon, petMenuJustOpened } = await import("./pet.js");

type Avatar = HTMLElement & {
  _sleeping?: boolean;
  _state?: string;
  getHeadRoundness(): number;
  startWaiting(options?: { variant?: string }): Promise<unknown>;
};

const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
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

beforeAll(() => {
  // Radix positions the menu with these.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  callStore.set(IDLE_CALL);
  prefsStore.set(defaultPreferences());
  setupStore.set(null);
  setSettingsFallback(null);
  engine.toggleCall.mockClear();
  engine.callMyPhone.mockClear();
});

describe("footer pet", () => {
  it("sleeps with no call, ignores clicks, and draws an outline", async () => {
    const icon = renderSlot({ component: PetIcon }, { className: "size-4" });
    try {
      const avatar = avatarIn(icon.container);
      expect(typeof (avatar as { sleep?: unknown }).sleep).toBe("function");
      expect(icon.container.querySelector(".dispatch-pet")?.getAttribute("data-mood")).toBe("sleep");
      expect(icon.container.querySelector("[title]")?.getAttribute("title")).toBe("Juno · asleep");
      // Clicks belong to the footer button, which toggles the call.
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

  it("opens a three-item menu on right-click and guards the footer click", async () => {
    const openSettings = vi.fn();
    setSettingsFallback(openSettings);
    setupStore.set(setup(true));
    const icon = renderSlot({ component: PetIcon }, { className: "size-4" });
    // Hold the clock: jsdom is slow to position the menu.
    const frozen = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(frozen);
    try {
      expect(petMenuJustOpened()).toBe(false);
      const trigger = icon.container.firstElementChild as HTMLElement;
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }));
      });
      // The release that ends a long press must not also toggle the call.
      expect(petMenuJustOpened()).toBe(true);
      const items = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
      expect(items.map((item) => item.textContent)).toEqual(["Wake Juno here", "Call my phone", "Dispatch settings"]);
      // The menu carries the plugin's portal scope and blocks the iOS callout.
      expect(items[0]!.closest("[data-bb-plugin-root]")).not.toBeNull();
      expect(trigger.className).toContain("[-webkit-touch-callout:none]");
      await act(async () => items[1]!.click());
      expect(engine.callMyPhone).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
      icon.unmount();
    }
  });

  it("labels the menu for a live call and disables the phone until it is set up", async () => {
    const openSettings = vi.fn();
    setSettingsFallback(openSettings);
    setupStore.set(setup(false));
    prefsStore.set({ ...defaultPreferences(), agentName: "Ada" });
    updateCall({ state: "live", owner: "self", startedAt: Date.now() });
    const icon = renderSlot({ component: PetIcon }, {});
    try {
      await act(async () => {
        (icon.container.firstElementChild as HTMLElement).dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
        );
      });
      const items = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
      expect(items[0]!.textContent).toBe("Put Ada to sleep");
      expect(items[1]!.hasAttribute("data-disabled")).toBe(true);
      expect(items[1]!.textContent).toBe("Call my phoneNeeds: Twilio account");
      await act(async () => items[2]!.click());
      expect(openSettings).toHaveBeenCalledTimes(1);
      expect(engine.callMyPhone).not.toHaveBeenCalled();
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
    updateCall({ state: "live", owner: "self", startedAt: Date.now(), activity: "you" });
    const pet = renderSlot({ component: MiniPet }, {});
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
  }, 10_000);
});
