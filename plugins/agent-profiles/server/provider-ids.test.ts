import { describe, expect, it } from "vitest";
import { AGENTS_PROVIDER_ID, agentModelId, profileIdFromAgentModel } from "./provider-ids";

const id = "5f0c8f5e-2d3c-4b8e-9a51-1f2e3d4c5b6a";

describe("stable agent model identity", () => {
  it("uses the profile UUID, not its mutable slug or execution model", () => {
    expect(AGENTS_PROVIDER_ID).toBe("agents");
    expect(agentModelId(id)).toBe(`agent/${id}`);
    expect(profileIdFromAgentModel(agentModelId(id))).toBe(id);
  });

  it.each(["not-a-uuid", "../../etc", "00000000-0000-0000-0000-000000000000"])(
    "rejects malformed profile UUID %s", (value) => {
      expect(() => agentModelId(value)).toThrow("Invalid agent profile ID");
    },
  );

  it.each(["agent/deckmaster", `agent-${id}`, `agent/${id}/extra`, `agent/${id.toUpperCase()}`, "agent/../../etc"])(
    "rejects malformed agent model %s", (value) => {
      expect(() => profileIdFromAgentModel(value)).toThrow("Invalid agent model ID");
    },
  );
});
