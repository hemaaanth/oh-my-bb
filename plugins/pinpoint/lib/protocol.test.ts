import { describe, expect, it } from "vitest";

import { decideProtocolAction, PICKER_PROTOCOL_VERSION } from "./protocol";

describe("Pinpoint picker protocol versioning", () => {
  it("exports a positive integer protocol version", () => {
    expect(Number.isInteger(PICKER_PROTOCOL_VERSION)).toBe(true);
    expect(PICKER_PROTOCOL_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("does nothing when the picker reports the current version", () => {
    expect(decideProtocolAction(PICKER_PROTOCOL_VERSION, false)).toBe("ok");
    // Even after a reload already happened, a match never blocks.
    expect(decideProtocolAction(PICKER_PROTOCOL_VERSION, true)).toBe("ok");
  });

  it("tolerates a newer picker (panel about to be updated) without reloading", () => {
    expect(decideProtocolAction(PICKER_PROTOCOL_VERSION + 1, false)).toBe("ok");
  });

  it("reloads exactly once on an older or missing version", () => {
    // First mismatch: reload the session so it picks up the new picker.
    expect(decideProtocolAction(PICKER_PROTOCOL_VERSION - 1, false)).toBe(
      "reload",
    );
    // Pre-versioning pickers don't report a protocol at all.
    expect(decideProtocolAction(undefined, false)).toBe("reload");
    // Second mismatch after the reload: block instead of looping.
    expect(decideProtocolAction(PICKER_PROTOCOL_VERSION - 1, true)).toBe(
      "block",
    );
    expect(decideProtocolAction(undefined, true)).toBe("block");
  });
});
