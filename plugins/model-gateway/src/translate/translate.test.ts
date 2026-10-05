import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fitReplay,
  estimateTokens,
  messagesToResponses,
  responsesJsonToMessages,
  responsesStreamToMessages,
  TranslateError,
  wrapKeyOutput,
} from "./index.js";
import { encodeReasoningEnvelope } from "./reasoning-envelope.js";

type Rec = Record<string, any>;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
// Sanitized Claude Code 2.1.280 request captures (see fixtures/_source).
const cc: Record<"title" | "turn" | "toolResult" | "webSearch" | "countTokens", Rec> = JSON.parse(fixture("claude-code-requests.json").toString());
const MODEL = "gpt-6-astra";

/** Feed bytes in small chunks so frames split across reads. */
async function* chunked(bytes: Uint8Array, size = 7): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
function sse(events: Rec[]): Uint8Array {
  return new TextEncoder().encode(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
}
async function translateStream(bytes: Uint8Array): Promise<Rec[]> {
  let text = "";
  for await (const chunk of responsesStreamToMessages(chunked(bytes), { requestModel: "claude-opus-5-5" })) text += new TextDecoder().decode(chunk);
  return text.split("\n\n").filter(Boolean).map(frame => {
    const [event, data] = frame.split("\n");
    const parsed = JSON.parse(data!.slice("data: ".length));
    expect(event).toBe(`event: ${parsed.type}`);
    return parsed;
  });
}
/** Fold Anthropic SSE events into the message Claude Code's SDK would build. */
function fold(events: Rec[]): Rec {
  const msg = { ...events[0]!.message, content: [] as Rec[] };
  const json: Record<number, string> = {};
  for (const e of events) {
    if (e.type === "content_block_start") msg.content[e.index] = { ...e.content_block };
    if (e.type === "content_block_delta") {
      const block = msg.content[e.index]!;
      if (e.delta.type === "text_delta") block.text += e.delta.text;
      if (e.delta.type === "thinking_delta") block.thinking += e.delta.thinking;
      if (e.delta.type === "signature_delta") block.signature = e.delta.signature;
      if (e.delta.type === "input_json_delta") json[e.index] = (json[e.index] ?? "") + e.delta.partial_json;
    }
    if (e.type === "content_block_stop" && json[e.index] !== undefined) msg.content[e.index]!.input = JSON.parse(json[e.index]!);
    if (e.type === "message_delta") Object.assign(msg, e.delta, { usage: e.usage });
  }
  return msg;
}

describe("messagesToResponses", () => {
  it("translates the main Claude Code turn", () => {
    const body = messagesToResponses(cc.turn, { model: MODEL });
    expect(body).toMatchObject({
      model: MODEL,
      store: false,
      stream: true,
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
    // Billing line dropped; the other top-level system blocks joined.
    expect(body.instructions).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nYou are an interactive agent. Synthetic harness system prompt.");
    // role "system" inside messages[] stays in place as a developer message.
    expect(body.input.map(i => i.role)).toEqual(["user", "developer"]);
    expect(body.input[0]!.content).toHaveLength(3);
    expect(body.input[1]!.content).toEqual([{ type: "input_text", text: "# Environment\nSynthetic environment context." }]);
    // Deferred placeholder hidden; every other tool is a non-strict function.
    expect(body.tools!.map(t => t.name)).toEqual(cc.turn.tools.map((t: Rec) => t.name).filter((n: string) => n !== "DeferredToolPlaceholder"));
    expect(body.tools!.every(t => t.type === "function" && t.strict === false)).toBe(true);
    expect(body.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
    // Nothing the ChatGPT backend rejects, and no Anthropic-only fields.
    expect(Object.keys(body).sort()).toEqual(["include", "input", "instructions", "model", "parallel_tool_calls", "prompt_cache_key", "reasoning", "store", "stream", "tool_choice", "tools"]);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("translates the session-title call: no thinking, structured output", () => {
    const body = messagesToResponses(cc.title, { model: "gpt-6-luna" });
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.include).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.instructions).toContain("You are naming a coding session.");
    expect(body.text).toEqual({ format: { type: "json_schema", name: "response", schema: cc.title.output_config.format.schema } });
  });

  it("maps the WebSearch sub-request's server tool to hosted web_search", () => {
    const body = messagesToResponses(cc.webSearch, { model: MODEL });
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "Perform a web search for the query: bb plugin sdk" }] }]);
  });

  it("translates the recorded tool_result follow-up", () => {
    const body = messagesToResponses(cc.toolResult, { model: MODEL });
    const toolUse = cc.toolResult.messages[2].content[1];
    expect(body.input.slice(1)).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: "# Environment\nSynthetic environment context." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll check that." }] },
      { type: "function_call", call_id: toolUse.id, name: "Bash", arguments: JSON.stringify(toolUse.input) },
      { type: "function_call_output", call_id: toolUse.id, output: "mock-tool-hello" },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "<total_tokens>14999965 tokens left</total_tokens>" }] },
    ]);
  });

  it("loads deferred tools named by tool_reference blocks", () => {
    const schema = { type: "object", properties: {} };
    const body = messagesToResponses({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "X" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "X" }] }] },
      ],
      tools: [
        { name: "ToolSearch", input_schema: schema },
        { name: "X", input_schema: schema, defer_loading: true },
        { name: "Y", input_schema: schema, defer_loading: true },
      ],
    }, { model: MODEL });
    expect(body.input.at(-1)).toEqual({
      type: "function_call_output", call_id: "t1",
      output: [{ type: "input_text", text: "Tool loaded: X" }],
    });
    expect(body.tools?.map(tool => tool.name)).toEqual(["ToolSearch", "X"]);
  });

  it("drops foreign (Anthropic) thinking and redacted_thinking", () => {
    const body = messagesToResponses({
      ...cc.turn,
      messages: [
        ...cc.turn.messages,
        { role: "assistant", content: [
          { type: "thinking", thinking: "native", signature: "EqQBCkYIBxgCKkBnative" },
          { type: "redacted_thinking", data: "EmwKAhgBEgy" },
          { type: "text", text: "done" },
        ] },
      ],
    }, { model: MODEL });
    expect(body.input.at(-1)).toEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] });
    expect(body.input.some(i => i.type === "reasoning")).toBe(false);
  });

  it.each([
    ["server tool", { tools: [{ type: "code_execution_20250522", name: "code_execution" }] }, /server tool "code_execution_20250522"/],
    ["file image", { messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "f1" } }] }] }, /image source "file"/],
    ["mcp_servers", { mcp_servers: [{ type: "url", url: "https://example.invalid" }] }, /mcp_servers/],
    ["invalid tool_reference", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference" }] }] }] }, /tool_reference requires tool_name/],
  ])("rejects %s with a 400-style error", (_name, patch, message) => {
    let error: unknown;
    try { messagesToResponses({ ...cc.turn, ...patch }, { model: MODEL }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(TranslateError);
    expect((error as TranslateError).status).toBe(400);
    expect((error as TranslateError).body.error.type).toBe("invalid_request_error");
    expect((error as TranslateError).body.error.message).toMatch(message);
  });
});

describe("Claude Code turn with two tool calls round-trips through ChatGPT", () => {
  it("request -> recorded ChatGPT stream -> Anthropic SSE -> tool_result follow-up", async () => {
    // 1. Request.
    expect(messagesToResponses(cc.turn, { model: MODEL }).input).toHaveLength(2);

    // 2. Stream back, in 7-byte chunks.
    const events = await translateStream(fixture("chatgpt-two-tools.sse"));
    expect(events.map(e => e.type).filter(t => t !== "content_block_delta")).toEqual([
      "message_start",
      "content_block_start", "content_block_stop", // thinking
      "content_block_start", "content_block_stop", // text
      "content_block_start", "content_block_stop", // tool_use Bash
      "content_block_start", "content_block_stop", // tool_use Read
      "message_delta", "message_stop",
    ]);
    const message = fold(events);
    expect(message).toMatchObject({
      model: "claude-opus-5-5",
      stop_reason: "tool_use",
      usage: { input_tokens: 1104, output_tokens: 180, cache_read_input_tokens: 4096, cache_creation_input_tokens: 0 },
    });
    const [thinking, text, bash, read] = message.content;
    expect(thinking).toMatchObject({ type: "thinking", thinking: "**Checking files** before running.\n\nTwo calls in parallel." });
    expect(thinking.signature).toMatch(/^mgw1:/);
    expect(text).toEqual({ type: "text", text: "I'll run both checks." });
    expect(bash).toEqual({ type: "tool_use", id: "call_fxBash01", name: "Bash", input: { command: "echo one", description: "Print one" } });
    expect(read).toEqual({ type: "tool_use", id: "call_fxRead02", name: "Read", input: { file_path: "/tmp/example.txt" } });

    // 3. Follow-up, shaped the way Claude Code sends it (see fixture toolResult): the old
    //    system turn collapses to a string, results come back, a fresh system turn is appended.
    const [user, system] = cc.turn.messages;
    const followUp = {
      ...cc.turn,
      messages: [
        user,
        { ...system, content: system.content[0].text },
        { role: "assistant", content: message.content },
        { role: "user", content: [
          { tool_use_id: "call_fxBash01", type: "tool_result", content: "one", is_error: false },
          { tool_use_id: "call_fxRead02", type: "tool_result", is_error: true, content: [
            { type: "text", text: "File does not exist." },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          ] },
        ] },
        { role: "system", content: [{ type: "text", text: "<total_tokens>14990000 tokens left</total_tokens>", cache_control: { type: "ephemeral" } }] },
      ],
    };
    const body = messagesToResponses(followUp, { model: MODEL });
    expect(body.input.slice(2)).toEqual([
      // Our own reasoning replays with its encrypted content.
      { type: "reasoning", id: "rs_fx1", summary: [{ type: "summary_text", text: "**Checking files** before running.\n\nTwo calls in parallel." }], encrypted_content: "gAAAAABsyntheticEncryptedReasoning==" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll run both checks." }] },
      { type: "function_call", call_id: "call_fxBash01", name: "Bash", arguments: "{\"command\":\"echo one\",\"description\":\"Print one\"}" },
      { type: "function_call", call_id: "call_fxRead02", name: "Read", arguments: "{\"file_path\":\"/tmp/example.txt\"}" },
      { type: "function_call_output", call_id: "call_fxBash01", output: "one" },
      { type: "function_call_output", call_id: "call_fxRead02", output: [
        { type: "input_text", text: "[tool error]" },
        { type: "input_text", text: "File does not exist." },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      ] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "<total_tokens>14990000 tokens left</total_tokens>" }] },
    ]);

    // 4. Failing back to Anthropic: gateway thinking is stripped, the rest is untouched.
    const back = fitReplay(followUp, "anthropic");
    expect(back.messages[2].content.map((b: Rec) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
    expect(followUp.messages[2]!.content).toHaveLength(4);
  });

  it("non-streaming: the completed response object gives the same message", async () => {
    const completed = fixture("chatgpt-two-tools.sse").toString().trim().split("\n\n").map(f => JSON.parse(f.split("\n")[1]!.slice(6))).at(-1)!;
    const json = responsesJsonToMessages(completed.response, { requestModel: "claude-opus-5-5" });
    const streamed = fold(await translateStream(fixture("chatgpt-two-tools.sse")));
    expect({ ...json, id: "" }).toEqual({ ...streamed, id: "" });
  });
});

describe("responsesStreamToMessages edge cases", () => {
  const created = { type: "response.created", response: { id: "r", status: "in_progress" } };

  it("maps hosted web search to server_tool_use + web_search_tool_result", async () => {
    const events = await translateStream(sse([
      created,
      { type: "response.output_item.done", item: { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "bb plugin sdk", sources: [{ type: "url", url: "https://example.com/a", title: "A" }] } } },
      { type: "response.output_text.delta", delta: "Found it." },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } },
    ]));
    const message = fold(events);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    expect(message.content).toEqual([
      { type: "server_tool_use", id: "srvtoolu_ws_1", name: "web_search", input: { query: "bb plugin sdk" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_ws_1", content: [{ type: "web_search_result", title: "A", url: "https://example.com/a" }] },
      { type: "text", text: "Found it." },
    ]);
  });

  it("maps max_output_tokens to stop_reason max_tokens", async () => {
    const events = await translateStream(sse([created, { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 9 } } }]));
    expect(fold(events).stop_reason).toBe("max_tokens");
  });

  it("turns response.failed into an Anthropic error event", async () => {
    const events = await translateStream(sse([created, { type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "slow down" } } }]));
    expect(events.at(-1)).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
  });

  it("treats EOF without a terminal event as a retryable error", async () => {
    const events = await translateStream(sse([created, { type: "response.output_text.delta", delta: "cut" }]));
    expect(events.slice(-2)).toEqual([
      { type: "content_block_stop", index: 0 },
      { type: "error", error: { type: "overloaded_error", message: "upstream stream ended before a terminal event" } },
    ]);
  });

  it("ends after the terminal event even if the upstream stays open", async () => {
    async function* openEnded() {
      yield sse([created, { type: "response.completed", response: {
        output: [{ id: "msg_final", type: "message", content: [{ type: "output_text", text: "done" }] }],
      } }]);
      await new Promise(() => {}); // never closes
    }
    const types: string[] = [];
    for await (const chunk of responsesStreamToMessages(openEnded(), { requestModel: "m", pingIntervalMs: 0 })) {
      types.push(/^event: (\S+)/.exec(new TextDecoder().decode(chunk))![1]!);
    }
    expect(types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  });

  it("recovers terminal-only output when the upstream omitted streaming deltas", async () => {
    const events = await translateStream(sse([created, { type: "response.completed", response: {
      output: [
        { id: "msg_final", type: "message", content: [{ type: "output_text", text: "Recovered answer." }] },
        { id: "call_final", type: "function_call", call_id: "call_1", name: "Read", arguments: "{\"file_path\":\"README.md\"}" },
      ],
      usage: { input_tokens: 8, output_tokens: 5 },
    } }]));
    const message = fold(events);
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      { type: "text", text: "Recovered answer." },
      { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "README.md" } },
    ]);
  });

  it("turns a genuinely empty completed response into a retryable error", async () => {
    const events = await translateStream(sse([created, { type: "response.completed", response: {} }]));
    expect(events.at(-1)).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "upstream completed without assistant content" },
    });
  });

  it("sends ping while the upstream is silent", async () => {
    async function* slow() {
      yield sse([created]);
      await new Promise(resolve => setTimeout(resolve, 40));
      yield sse([{ type: "response.completed", response: {
        output: [{ id: "msg_final", type: "message", content: [{ type: "output_text", text: "done" }] }],
      } }]);
    }
    const types: string[] = [];
    for await (const chunk of responsesStreamToMessages(slow(), { requestModel: "m", pingIntervalMs: 5 })) {
      types.push(/^event: (\S+)/.exec(new TextDecoder().decode(chunk))![1]!);
    }
    expect(types[0]).toBe("message_start");
    expect(types).toContain("ping");
    expect(types.slice(-2)).toEqual(["message_delta", "message_stop"]);
  });
});

describe("estimateTokens", () => {
  it("estimates a count_tokens body and charges media a flat cost", () => {
    const base = estimateTokens(cc.countTokens);
    expect(base).toBeGreaterThan(50);
    const withImage = estimateTokens({ ...cc.countTokens, messages: [{ role: "user", content: [
      { type: "text", text: "foo" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(100_000) } },
    ] }] });
    expect(withImage).toBeGreaterThan(base + 1000);
    expect(withImage).toBeLessThan(base + 2000);
    expect(estimateTokens(cc.turn)).toBeGreaterThan(estimateTokens(cc.title));
  });
});

describe("replay identity", () => {
  it("replays thinking and reasoning only to the upstream that minted it", () => {
    const openrouter = "responses-compatible-key:openrouter";
    const signature = encodeReasoningEnvelope({ id: "rs_or", enc: "or-enc", up: openrouter });
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature }, { type: "text", text: "x" }] },
        { role: "user", content: "more" },
      ],
    };
    expect(JSON.stringify(messagesToResponses(body, { model: MODEL }).input)).not.toContain("or-enc");
    expect(messagesToResponses(body, { model: "openai/gpt-6", upstream: openrouter }).input)
      .toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: "or-enc" }));

    // A key's redacted thinking round-trips; everyone else loses it, and the empty turn.
    const output = { content: [{ type: "redacted_thinking", data: "opaque" }] };
    expect(wrapKeyOutput(output, "anthropic-compatible-key:kimi")).toBe(true);
    const history = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: output.content }] };
    expect(fitReplay(history, "anthropic-compatible-key:kimi").messages[1]!.content).toEqual([{ type: "redacted_thinking", data: "opaque" }]);
    expect(fitReplay(history, "anthropic").messages).toEqual([{ role: "user", content: "hi" }]);
    expect(fitReplay(history, "anthropic-compatible-key:glm").messages).toHaveLength(1);
  });
});
