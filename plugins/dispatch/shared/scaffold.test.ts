import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { DISPATCH_VERSION, SECRET_IDS, type SecretId, defaultPreferences } from "./constants.js";
import { METHOD_NAMES, preferencesSchema, type RpcMethod, type RpcOutput } from "./contract.js";

describe("shared constants", () => {
  it("has the preference defaults from CONTRACTS §4.1", () => {
    expect(defaultPreferences()).toEqual({
      agentName: "Juno",
      voice: "gleam",
      voiceModel: "gpt-live-1",
      reasoningModel: "gpt-5.6-terra",
      announcements: true,
      mobileDrawerBehavior: "reuse",
      callMemory: true,
      memoryRetentionDays: 90,
      homeTimeZone: "",
      pluginAccess: { mode: "all" },
      hotkeys: { toggle: "Mod+Shift+H", mute: "Mod+Shift+U" },
      pet: { style: "outline", color: "theme", roundness: 50, followPointer: true, antennaFlash: false },
      voiceStyle: { pace: "natural", energy: "neutral", expressiveness: "balanced", length: "balanced", backchannels: "moderate", notes: "" },
      customVoices: [],
    });
    expect(preferencesSchema.parse(defaultPreferences())).toEqual(defaultPreferences());
  });

  it("returns a fresh defaults object each call", () => {
    const first = defaultPreferences();
    first.pet.roundness = 0;
    expect(defaultPreferences().pet.roundness).toBe(50);
  });

  it("keeps the version in step with package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(DISPATCH_VERSION).toBe(pkg.version);
  });

  it("lists the six setup ids in form order", () => {
    expect(SECRET_IDS).toEqual(["openaiKey", "twilioSid", "twilioToken", "twilioCallerNumber", "yourPhoneNumber", "openaiSipProject"]);
  });

  it("has a contract entry for every RPC method in CONTRACTS §3", () => {
    expect([...METHOD_NAMES].sort()).toEqual(
      [
        "openCall",
        "endCallsEverywhere",
        "announcePresence",
        "pollPresence",
        "relayCommand",
        "phoneDial",
        "toolInvoke",
        "traceAppend",
        "callsPage",
        "callTrace",
        "usageReport",
        "liveStatus",
        "forgetCall",
        "preferencesRead",
        "preferencesWrite",
        "preferencesReset",
        "setupStatus",
        "pluginsWithCommands",
        "instructionsRead",
        "instructionsWrite",
        "instructionsHistory",
        "instructionsRestore",
        "promptPreview",
        "drawerResolveThreads",
        "voiceSample",
        "voiceCreate",
        "voiceRemove",
      ].sort(),
    );
  });
});

// A setup value must never reach the browser. This finds any field, at any
// depth of any RPC output, that is named like a setup id and can hold a string.
type SecretShapedFields<T> = T extends readonly (infer Item)[]
  ? SecretShapedFields<Item>
  : T extends object
    ? { [K in keyof T]-?: K extends SecretId ? (string extends Exclude<T[K], undefined | null> ? K : SecretShapedFields<T[K]>) : SecretShapedFields<T[K]> }[keyof T]
    : never;

describe("setup values in RPC output types", () => {
  it("finds a string field named like a setup id", () => {
    expectTypeOf<SecretShapedFields<{ nested: Array<{ twilioToken?: string }> }>>().toEqualTypeOf<"twilioToken">();
    expectTypeOf<SecretShapedFields<{ fields: Record<SecretId, boolean> }>>().toEqualTypeOf<never>();
  });

  it("finds none in any RPC output", () => {
    expectTypeOf<{ [M in RpcMethod]: SecretShapedFields<RpcOutput<M>> }[RpcMethod]>().toEqualTypeOf<never>();
  });
});
