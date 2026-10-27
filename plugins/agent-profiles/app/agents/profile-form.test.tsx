// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { profileInputSchema, rpcContract, type Profile } from "../../server/contract";
import { ProfileForm } from "./profile-form";

const profile: Profile = {
  ...profileInputSchema.parse({
    name: "Reviewer", slug: "reviewer", description: "Review code",
    providerId: "claude-code", model: "claude-opus-4-6", modelMode: "pinned",
    reasoningLevel: "high", serviceTier: "priority", permissionMode: "full",
    instructions: "Review carefully", skillIds: [], mcpServerIds: [], isDefault: false,
  }),
  id: "5f0c8f5e-2d3c-4b8e-9a51-1f2e3d4c5b6a", revision: 1,
  memoryKey: "agent-5f0c8f5e-2d3c-4b8e-9a51-1f2e3d4c5b6a",
  createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z",
  homeReady: true, intervalMinutes: null,
};

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Pi-only profile settings", () => {
  it("corrects an unsupported saved pin while preserving a reserved DM's default project", async () => {
    let saved: Profile | undefined;
    const slot = renderSlot<{ profile: Profile; onSaved: (result: Profile) => void }>(
      { component: ProfileForm },
      { profile, onSaved: (result) => { saved = result; } },
      {
        sdk: { projects: { list: async () => [] } },
        rpc: {
          agentDetail: () => ({ profile, home: { path: "/tmp/home", hostId: null, ready: true }, runsInLocked: true }),
          models: () => [{ model: "openai-codex/gpt-6-sol", displayName: "GPT 6 Sol", reasoningLevels: ["medium", "high"], defaultReasoningLevel: "medium" }],
          modelLevelPreview: () => ({
            codex: { providerId: "hempi", model: "openai-codex/gpt-6-sol", displayName: "GPT 6 Sol", reasoningLevel: "high", family: "codex", reason: "level" },
          }),
          saveProfile: (input) => ({ ...profile, ...rpcContract.saveProfile.input.parse(input), revision: 2 }),
        },
      },
    );
    expect(slot.queryByRole("combobox", { name: "Harness" })).toBeNull();
    expect(slot.getByRole("combobox", { name: "Pinned model" }).textContent).toContain("Unsupported saved pin");
    expect((slot.getByRole("combobox", { name: "Default project" }) as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(slot.getByRole("switch", { name: "Pin exact model" }));
    fireEvent.click(slot.getByRole("radio", { name: "High" }));
    await slot.findByText("Codex: GPT 6 Sol · high");
    fireEvent.click(slot.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(saved?.level).toBe("high"));
    expect(saved?.modelMode).toBe("level");
    expect(saved?.providerId).toBe("claude-code");
  });
});
