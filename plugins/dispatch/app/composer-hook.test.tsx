// @vitest-environment jsdom
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import { currentBindings } from "@/voice/bindings.js";
import { COMPOSER_MARKER } from "@/app/pointer-ghost/model.js";

import { ComposerHook } from "./composer-hook.js";

describe("composer hook", () => {
  it("draws nothing but registers the composer bindings", () => {
    const strip = renderSlot({ component: ComposerHook }, {}, { composer: { text: "hello", scope: { kind: "thread", threadId: "t1" } } });
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
    const strip = renderSlot({ component: ComposerHook }, {}, { composer: { scope: { kind: "new-thread", projectId: "p1" } } });
    try {
      expect(currentBindings()?.context()).toEqual({ threadId: null, projectId: "p1", onNewThreadScreen: true });
    } finally {
      strip.unmount();
    }
  });
});
