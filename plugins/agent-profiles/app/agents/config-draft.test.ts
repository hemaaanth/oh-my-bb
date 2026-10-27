import { describe, expect, it } from "vitest";
import { profileInputSchema } from "../../server/contract";
import { draftProfileInputSchema, profileDraft } from "./config-draft";

const valid = {
  name: "Reviewer",
  slug: "reviewer",
  description: "Reviews pull requests",
  providerId: "codex",
  model: "gpt-5.6-sol",
  reasoningLevel: "medium",
  serviceTier: "default",
  permissionMode: "auto",
  instructions: "Be precise.",
  skillIds: ["pr-review"],
  mcpServerIds: [],
  isDefault: false,
};

const cases: Array<[string, unknown]> = [
  ["minimal valid input with defaults", valid],
  ["every field set", {
    ...valid,
    id: "5f0c8f5e-2d3c-4b8e-9a51-1f2e3d4c5b6a",
    kind: "thin",
    avatar: "🦊",
    modelMode: "pinned",
    level: "xhigh",
    runProjectId: "proj_1",
    runHostId: "host_1",
  }],
  ["whitespace is trimmed", { ...valid, name: "  Reviewer  ", slug: " reviewer ", skillIds: [" a "], providerId: " codex " }],
  ["provider-defined service tier", { ...valid, serviceTier: "priority" }],
  ["blank service tier", { ...valid, serviceTier: "   " }],
  ["null project", { ...valid, runProjectId: null }],
  ["empty project", { ...valid, runProjectId: "" }],
  ["blank name", { ...valid, name: "   " }],
  ["long name", { ...valid, name: "x".repeat(81) }],
  ["bad slug", { ...valid, slug: "Bad Slug" }],
  ["long slug", { ...valid, slug: "a".repeat(61) }],
  ["bad id", { ...valid, id: "not-a-uuid" }],
  ["unknown key", { ...valid, extra: true }],
  ["unknown enum", { ...valid, reasoningLevel: "extreme" }],
  ["unknown level", { ...valid, level: "medium-high" }],
  ["long avatar", { ...valid, avatar: "x".repeat(17) }],
  ["blank skill", { ...valid, skillIds: ["  "] }],
  ["too many skills", { ...valid, skillIds: Array.from({ length: 101 }, (_, index) => `s${index}`) }],
  ["long instructions", { ...valid, instructions: "x".repeat(32_001) }],
  ["missing field", { ...valid, isDefault: undefined }],
  ["not an object", "reviewer"],
  ["null", null],
];

describe("draft profile validation", () => {
  it("accepts provider-defined service tiers but rejects empty ids", () => {
    expect(profileInputSchema.parse({ ...valid, serviceTier: "priority" }).serviceTier).toBe("priority");
    expect(draftProfileInputSchema.parse({ ...valid, serviceTier: "priority" }).serviceTier).toBe("priority");
    expect(profileInputSchema.safeParse({ ...valid, serviceTier: "   " }).success).toBe(false);
    expect(draftProfileInputSchema.safeParse({ ...valid, serviceTier: "   " }).success).toBe(false);
  });
  it.each(cases)("matches the server schema: %s", (_label, input) => {
    const server = profileInputSchema.safeParse(input);
    const draft = draftProfileInputSchema.safeParse(input);
    expect(draft.success).toBe(server.success);
    if (server.success) expect(draft.data).toEqual(server.data);
  });

  it("rejects a stale harness choice in an unsaved draft and retains a valid pin", () => {
    const pinned = { ...valid, modelMode: "pinned", providerId: "hempi", model: "openai-codex/gpt-6-sol" };
    const saved = { draft: pinned, baseline: valid, skillIdsText: "pr-review", mcpServerIdsText: "", revision: 3 };
    expect(profileDraft(saved).draft).toMatchObject(pinned);
    expect(() => profileDraft({ ...saved, draft: { ...pinned, piHarness: false } })).toThrow();
  });

  it("restores a saved draft and rejects a stale one", () => {
    const saved = {
      draft: valid,
      baseline: valid,
      skillIdsText: "pr-review",
      mcpServerIdsText: "",
      revision: 3,
    };
    expect(profileDraft(saved).draft).toEqual(profileInputSchema.parse(valid));
    expect(() => profileDraft({ ...saved, draft: { ...valid, slug: "Bad Slug" } })).toThrow();
  });
});
