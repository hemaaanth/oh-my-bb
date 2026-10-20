import { describe, expect, it } from "vitest";
import { hostRow, makeContext, projectRow } from "../core-test-host.js";
import {
  editDistance,
  matchName,
  normaliseName,
  providersFor,
  resolveMachine,
  resolveModel,
  resolveProvider,
  routingTarget,
  type HostRow,
  type ProjectRow,
  type ProviderEntry,
} from "./resolve.js";

const hosts = [
  hostRow(),
  hostRow({ id: "host_b", name: "MacBook Pro", status: "connected" }),
  hostRow({ id: "host_c", name: "MacBook Air", status: "disconnected" }),
] as unknown as HostRow[];

const providers: ProviderEntry[] = [
  {
    id: "codex",
    displayName: "Codex",
    models: [
      { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
      { id: "gpt-5.5-mini", displayName: "GPT-5.5 Mini", isDefault: false },
    ],
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    models: [
      { id: "claude-opus-5-5", displayName: "Opus 5.5", isDefault: true },
      { id: "claude-sonnet-5-5", displayName: "Sonnet 5.5", isDefault: false },
    ],
  },
  { id: "pi", displayName: "Pi", models: [{ id: "opus-5.5", displayName: "Opus 5.5", isDefault: true }] },
];

describe("name matching", () => {
  it("normalises case and separators", () => {
    expect(normaliseName("Claude-Code 5.5_x/y")).toBe("claudecode55xy");
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("matches exact, then by tokens, then by edit distance", () => {
    const items = ["Claude Code", "Codex"];
    expect(matchName("claude code", items, (item) => [item])).toEqual({ ok: true, item: "Claude Code" });
    expect(matchName("claude", items, (item) => [item])).toEqual({ ok: true, item: "Claude Code" });
    expect(matchName("codx", items, (item) => [item])).toEqual({ ok: true, item: "Codex" });
    expect(matchName("gemini", items, (item) => [item])).toMatchObject({ ok: false, reason: "none" });
  });
});

describe("resolveMachine", () => {
  it("finds a machine by id, exact name, and unique substring", () => {
    expect(resolveMachine("host_b", hosts).id).toBe("host_b");
    expect(resolveMachine("STUDIO", hosts).id).toBe("host_a");
    expect(resolveMachine("air", hosts).id).toBe("host_c");
  });

  it("lists the connected machines when the name is ambiguous or unknown", () => {
    expect(() => resolveMachine("macbook", hosts)).toThrow('"macbook" matches more than one machine. Connected machines: studio, MacBook Pro.');
    expect(() => resolveMachine("laptop", hosts)).toThrow('No machine is named "laptop". Connected machines: studio, MacBook Pro.');
  });
});

describe("resolveProvider and resolveModel", () => {
  it("resolves a provider by normalised name, token, and edit distance", () => {
    expect(resolveProvider("claude code", providers).id).toBe("claude-code");
    expect(resolveProvider("claude", providers).id).toBe("claude-code");
    expect(resolveProvider("codecs", providers).id).toBe("codex");
    expect(() => resolveProvider("gemini", providers)).toThrow(/No provider is named "gemini". Choices: Codex, Claude Code, Pi/);
  });

  it("resolves a model across providers", () => {
    expect(resolveModel("sonnet", providers)).toMatchObject({ provider: { id: "claude-code" }, model: { id: "claude-sonnet-5-5" } });
    expect(resolveModel("gpt 5.5 mini", providers).model.id).toBe("gpt-5.5-mini");
  });

  it("lists Model (Provider) when a model name is ambiguous", () => {
    expect(() => resolveModel("opus 5.5", providers)).toThrow(
      '"opus 5.5" matches more than one model. Choices: Opus 5.5 (Claude Code), Opus 5.5 (Pi).',
    );
  });
});

describe("routing target", () => {
  const project = projectRow() as unknown as ProjectRow;

  it("prefers the host, then the environment, then the project's default host", () => {
    expect(routingTarget({ hostId: "host_b", environmentId: "env_a", project })).toEqual({ kind: "host", hostId: "host_b", projectId: "proj_a" });
    expect(routingTarget({ environmentId: "env_a", project })).toEqual({ kind: "environment", environmentId: "env_a" });
    expect(routingTarget({ project })).toEqual({ kind: "project", hostId: "host_a", projectId: "proj_a" });
    expect(routingTarget({})).toEqual({ kind: "none" });
  });

  it("scopes the provider lookup to the target", async () => {
    const { ctx, harness } = await makeContext(undefined, {
      providers: {
        list: async () => [
          { id: "codex", displayName: "Codex", available: true },
          { id: "gone", displayName: "Gone", available: false },
        ],
        models: async () => ({ models: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] }),
      },
    } as never);
    const found = await providersFor(ctx, { kind: "project", hostId: "host_a", projectId: "proj_a" });
    expect(found.map((provider) => provider.id)).toEqual(["codex"]);
    expect(harness.inspection.sdk.callsTo("providers.list")).toEqual([[{ hostId: "host_a" }]]);
    expect(harness.inspection.sdk.callsTo("providers.models")).toEqual([[{ hostId: "host_a", providerId: "codex", projectId: "proj_a" }]]);
  });
});
