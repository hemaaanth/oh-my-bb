// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { APP_STORAGE_CAP, MAX_ANSWER_LENGTH } from "./appDocument.js";
import { APPS_STORAGE_BUDGET, parseAppMessage, parseStorageItems, readAppStorage, saveAppStorage, storageSize } from "./appBridge.js";

describe("app bridge boundaries", () => {
  it("accepts exact message shapes and rejects additional capabilities", () => {
    expect(parseAppMessage({ source: "genui-app", type: "height", height: 123.5 })).toEqual({ type: "height", height: 123.5 });
    for (const message of [
      { source: "other", type: "height", height: 20 },
      { source: "genui-app", type: "height", height: Infinity },
      { source: "genui-app", type: "height", height: -1 },
      { source: "genui-app", type: "storage", items: {}, stateKey: "another-app" },
      { source: "genui-app", type: "execute", code: "not a bridge capability" },
    ]) expect(parseAppMessage(message)).toBeNull();
  });

  it("bounds answers and accepts explicit withdrawal", () => {
    expect(parseAppMessage({ source: "genui-app", type: "answer", text: `  ${"x".repeat(MAX_ANSWER_LENGTH + 1)}  ` })).toEqual({ type: "answer", text: "x".repeat(MAX_ANSWER_LENGTH) });
    expect(parseAppMessage({ source: "genui-app", type: "answer", text: "   " })).toEqual({ type: "answer", text: null });
    expect(parseAppMessage({ source: "genui-app", type: "answer", text: null })).toEqual({ type: "answer", text: null });
  });

  it("allows normalized HTTPS links, not script or other protocols", () => {
    expect(parseAppMessage({ source: "genui-app", type: "openLink", url: "HTTPS://EXAMPLE.COM/a" })).toEqual({ type: "openLink", url: "https://example.com/a" });
    for (const url of ["javascript:alert(1)", "http://example.com", "file:///tmp/a", "data:text/html,hello"]) expect(parseAppMessage({ source: "genui-app", type: "openLink", url })).toBeNull();
  });

  it("keeps prototype-like storage keys as data and enforces the app cap", () => {
    const items = parseStorageItems(JSON.parse('{"__proto__":"data","constructor":"value"}'))!;
    expect(Object.getPrototypeOf(items)).toBe(Object.prototype);
    expect(Object.hasOwn(items, "__proto__")).toBe(true);
    expect(items.__proto__).toBe("data");
    expect(parseStorageItems({ value: "x".repeat(APP_STORAGE_CAP - 5) })).not.toBeNull();
    expect(parseStorageItems({ value: "x".repeat(APP_STORAGE_CAP - 4) })).toBeNull();
    expect(parseStorageItems({ value: 1 })).toBeNull();
  });

  it("evicts the oldest app storage without removing BB's other values", () => {
    // Vitest's Node globals can mask top-window storage; a child has native jsdom Storage.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    vi.stubGlobal("localStorage", frame.contentWindow!.localStorage);
    try {
      localStorage.setItem("bb-native-pref", "keep");
      const items = { value: "x".repeat(APP_STORAGE_CAP - 5) };
      const count = APPS_STORAGE_BUDGET / storageSize(items);
      for (let i = 0; i <= count; i++) saveAppStorage(`fixture-${i}`, items);
      expect(readAppStorage("fixture-0")).toEqual({});
      expect(readAppStorage(`fixture-${count}`)).toEqual(items);
      expect(localStorage.getItem("bb-native-pref")).toBe("keep");
      saveAppStorage(`fixture-${count}`, {});
      expect(readAppStorage(`fixture-${count}`)).toEqual({});
    } finally {
      vi.unstubAllGlobals();
      frame.remove();
    }
  });
});
