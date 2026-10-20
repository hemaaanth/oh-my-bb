import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_KEYS } from "@/shared/constants.js";
import { listDevices, micConstraints, pickDevice, readAudioChoice } from "./audio-devices.js";

const mic = (deviceId: string, label = "") => ({ deviceId, kind: "audioinput" as const, label });
const speaker = (deviceId: string, label = "") => ({ deviceId, kind: "audiooutput" as const, label });

describe("pickDevice", () => {
  it("uses the saved device while it is present", () => {
    expect(pickDevice([mic("a"), mic("b")], "audioinput", "b")).toBe("b");
    expect(pickDevice([speaker("s")], "audiooutput", "s")).toBe("s");
  });

  it("falls back to the system default when the saved device disappears", () => {
    expect(pickDevice([mic("a")], "audioinput", "gone")).toBeNull();
    // An id of the other kind does not count.
    expect(pickDevice([speaker("b")], "audioinput", "b")).toBeNull();
    expect(pickDevice([mic("a")], "audioinput", null)).toBeNull();
    expect(micConstraints(null)).not.toHaveProperty("deviceId");
    expect(micConstraints("b")).toMatchObject({ deviceId: { exact: "b" } });
  });
});

describe("listDevices", () => {
  it("hides labels before permission behind generic names", () => {
    expect(listDevices([mic("a"), mic("b"), speaker("s")], "audioinput")).toEqual([
      { id: "a", label: "Microphone 1" },
      { id: "b", label: "Microphone 2" },
    ]);
    expect(listDevices([speaker("s")], "audiooutput")).toEqual([{ id: "s", label: "Speaker 1" }]);
    expect(listDevices([mic("a", "Studio mic")], "audioinput")).toEqual([{ id: "a", label: "Studio mic" }]);
    // Before permission some browsers list one device with an empty id.
    expect(listDevices([mic("")], "audioinput")).toEqual([]);
  });
});

describe("readAudioChoice", () => {
  const values = new Map<string, string>();
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    });
  });
  afterEach(() => {
    values.clear();
    vi.unstubAllGlobals();
  });

  it("reads the saved ids and ignores bad values", () => {
    expect(readAudioChoice()).toEqual({ inputDeviceId: null, outputDeviceId: null });
    values.set(LOCAL_KEYS.audio, JSON.stringify({ inputDeviceId: "a", outputDeviceId: 3 }));
    expect(readAudioChoice()).toEqual({ inputDeviceId: "a", outputDeviceId: null });
    values.set(LOCAL_KEYS.audio, "{not json");
    expect(readAudioChoice()).toEqual({ inputDeviceId: null, outputDeviceId: null });
  });
});
