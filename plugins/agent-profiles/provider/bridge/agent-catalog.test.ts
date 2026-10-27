import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { agentCatalogSnapshot, pickerDisplayName } from "../agent-catalog.js";
import { startFakePiBridge, type FakePiBridgeHarness } from "./test-support.js";

let bridge: FakePiBridgeHarness;

beforeEach(async () => {
  bridge = await startFakePiBridge({ prefix: "agents-catalog-", initialize: true });
});
afterEach(async () => {
  await bridge.teardown();
});

const resultSchema = z.object({ models: z.array(z.object({ id: z.string(), displayName: z.string(), isDefault: z.boolean() })), selectedOnlyModels: z.array(z.unknown()) });
const agent = { id: "166ed858-eb51-4b88-a8da-fba99329bc6e", name: "Deckmaster", reasoningLevel: "high" };

it("returns the registered agent identities, including an empty catalog, without probing Pi", async () => {
  const empty = agentCatalogSnapshot([]);
  const cold = await bridge.request(101, "model/list", { cwd: bridge.workspaceDir, providerOptions: empty });
  expect(cold.error).toBeUndefined();
  expect(resultSchema.parse(cold.result)).toEqual({ models: [], selectedOnlyModels: [] });

  const snapshot = agentCatalogSnapshot([agent]);
  const warm = await bridge.request(102, "model/list", { cwd: bridge.workspaceDir, providerOptions: snapshot });
  expect(warm.error).toBeUndefined();
  expect(resultSchema.parse(warm.result)).toMatchObject({
    models: [{ id: `agent/${agent.id}`, displayName: "Deckmaster", isDefault: true }],
    selectedOnlyModels: [],
  });
  expect(JSON.stringify(warm.result)).not.toContain("openai-codex/gpt-fake");
  expect((await bridge.request(103, "model/list", { providerOptions: { ...snapshot, agents: [{ ...snapshot.agents[0], modelId: "agent/invalid" }] } })).error).toBeDefined();
});

it("preserves the live Pi model catalog for plain Hempi", async () => {
  const response = await bridge.request(104, "model/list", { cwd: bridge.workspaceDir, providerOptions: {} });
  expect(response.error).toBeUndefined();
  expect(resultSchema.parse(response.result).models.map(({ id }) => id)).toContain("openai-codex/gpt-fake");
  expect(resultSchema.parse(response.result).models.every(({ id }) => !id.startsWith("agent/"))).toBe(true);
});

it("keeps all-caps agent names from being title-cased by the picker", () => {
  expect(pickerDisplayName("SDR")).toBe("SDR\u2060");
  expect(pickerDisplayName("AM")).toBe("AM\u2060");
  expect(pickerDisplayName("Deckmaster")).toBe("Deckmaster");
  expect(pickerDisplayName("PR Review")).toBe("PR Review");
  expect(pickerDisplayName("GTM-Lead")).toBe("GTM\u2060-Lead");
});
