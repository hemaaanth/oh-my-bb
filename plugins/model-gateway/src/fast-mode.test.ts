import { describe, expect, it } from "vitest";
import { translateFor, type ChainCandidate } from "./hub.js";
import { createClaudeAdapter } from "./upstreams/claude-adapter.js";
import { createCodexAdapter } from "./upstreams/codex-adapter.js";
import { messagesJsonToResponses, messagesStreamToResponses, messagesToResponses, responsesJsonToMessages, responsesStreamToMessages } from "./translate/index.js";

const claude = createClaudeAdapter({ refreshUrl: "https://auth.test", usageUrl: "https://usage.test", profileUrl: "https://profile.test" });
const codex = createCodexAdapter({ refreshUrl: "https://auth.test", usageUrl: "https://usage.test" });
const candidate = (model: string): ChainCandidate => ({ kind: "claude-oauth", replay: "anthropic", accounts: [], client: codex, upstream: claude, model });
const options = { requestModel: "claude-opus-5-5", upstreamModel: "claude-opus-5-5", tools: { custom: new Set<string>(), namespaced: new Map() } };

describe("Fast mode through protocol translation", () => {
  it.each([
    ["claude-opus-5-5", true, false],
    ["claude-opus-5", true, true],
    ["claude-opus-4-8-20260701", true, true],
    ["claude-sonnet-5-5", false, false],
    ["claude-opus-4-7", false, false],
  ])("translates priority for %s and sends its required beta header", (model, fast, beta) => {
    const json = { model, input: "Hello", service_tier: "priority" };
    const result = translateFor(candidate(model), { request: new Request("http://gateway.test/v1/responses"), json, body: new TextEncoder().encode(JSON.stringify(json)) });
    if (result instanceof Response) throw new Error("Unexpected rejected translation");
    expect(JSON.parse(new TextDecoder().decode(result.body)).speed).toBe(fast ? "fast" : undefined);
    expect(result.request.headers.get("anthropic-beta")).toBe(beta ? "fast-mode-2026-02-01" : null);
    expect(result.dropped).toEqual(fast ? [] : ["service_tier:priority"]);
  });

  it("preserves Claude Fast mode when failing over to Codex", () => {
    const body = { model: "claude-opus-5-5", messages: [{ role: "user", content: "Hello" }] };
    expect(messagesToResponses({ ...body, speed: "fast" }, { model: "gpt-6-sol" }).service_tier).toBe("priority");
    expect(messagesToResponses(body, { model: "gpt-6-sol" }).service_tier).toBeUndefined();
  });

  it.each([["fast", "priority"], ["standard", "default"], [undefined, undefined]])("reports only Claude's returned JSON speed %s", (speed, tier) => {
    const result = messagesJsonToResponses({ content: [], stop_reason: "end_turn", usage: { speed } }, options);
    expect(result.service_tier).toBe(tier);
  });

  it.each([["fast", "priority"], ["standard", "default"], [undefined, undefined]])("preserves Claude's final streamed speed %s", async (speed, tier) => {
    const events = [
      { type: "message_start", message: { usage: { speed: "fast", input_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1, speed } },
      { type: "message_stop" },
    ];
    async function* stream() { yield new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); }
    let output = "";
    for await (const chunk of messagesStreamToResponses(stream(), options)) output += new TextDecoder().decode(chunk);
    const terminal = output.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.completed");
    // Missing fields on later deltas do not erase the speed reported at message_start.
    expect(terminal.response.service_tier).toBe(tier ?? "priority");
  });

  it.each([["priority", "fast"], ["default", "standard"], [undefined, undefined]])("reports the returned Codex tier %s to Messages clients", async (tier, speed) => {
    const response = { service_tier: tier, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 1, output_tokens: 1 } };
    expect((responsesJsonToMessages(response, { requestModel: "claude-opus-5-5" }).usage as Record<string, unknown>).speed).toBe(speed);
    async function* stream() { yield new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`); }
    let output = "";
    for await (const chunk of responsesStreamToMessages(stream(), { requestModel: "claude-opus-5-5" })) output += new TextDecoder().decode(chunk);
    const terminal = output.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "message_delta");
    expect(terminal.usage.speed).toBe(speed);
  });

});
