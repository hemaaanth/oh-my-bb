import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fitReplay,
  messagesJsonToResponses,
  messagesStreamToResponses,
  messagesToResponses,
  responsesToMessages,
} from "./index.js";
import { decodeThinkingEnvelope } from "./reasoning-envelope.js";

type Rec = Record<string, any>;
// Synthetic Anthropic-compatible stream: thinking, text, then two tool calls.
const twoTools = readFileSync(new URL("./fixtures/anthropic-two-tools.sse", import.meta.url));
const MODEL = "kimi-k3";

/** A Codex-style first turn: developer + user messages, function, custom, namespace and hosted tools. */
const codexTurn: Rec = {
  model: "gpt-6-sol",
  instructions: "You are Codex.",
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions>workspace-write</permissions>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "List the files, then patch the README." }] },
  ],
  tools: [
    {
      type: "function",
      name: "shell",
      description: "Run a command.",
      strict: false,
      parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } }, required: ["command"] },
    },
    { type: "custom", name: "apply_patch", description: "Apply a patch.", format: { type: "grammar", syntax: "lark", definition: "start: begin_patch" } },
    { type: "namespace", name: "mcp__docs", tools: [{ type: "function", name: "search", description: "Search docs.", parameters: { type: "object", properties: { q: { type: "string" } } } }] },
    { type: "web_search" },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "medium", summary: "auto" },
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "cache-key",
  store: false,
  stream: true,
};

async function* chunked(bytes: Uint8Array, size = 11): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function translateStream(bytes: Uint8Array, tools = responsesToMessages(codexTurn, { model: MODEL, stream: true }).tools): Promise<Rec[]> {
  let text = "";
  for await (const chunk of messagesStreamToResponses(chunked(bytes), { requestModel: "gpt-6-sol", upstreamModel: MODEL, tools }))
    text += new TextDecoder().decode(chunk);
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const [event, data] = frame.split("\n");
    const parsed = JSON.parse(data!.slice("data: ".length));
    expect(event).toBe(`event: ${parsed.type}`);
    return parsed;
  });
}

const anthropicSse = (events: Rec[]) =>
  new TextEncoder().encode(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));

describe("Responses -> Messages request", () => {
  it("translates a Codex turn: system, merged user turn, tools, thinking budget", () => {
    const { body, tools }: { body: Rec; tools: ReturnType<typeof responsesToMessages>["tools"] } = responsesToMessages(codexTurn, { model: MODEL, stream: true });
    expect(body).toMatchObject({
      model: MODEL,
      stream: true,
      system: "You are Codex.",
      max_tokens: 32_000,
      thinking: { type: "enabled", budget_tokens: 8_192 },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<permissions>workspace-write</permissions>" },
            { type: "text", text: "List the files, then patch the README." },
          ],
        },
      ],
    });
    expect(body.tools.map((t: Rec) => t.name)).toEqual(["shell", "apply_patch", "mcp__docs__search"]);
    expect(body.tools[1].input_schema).toEqual({
      type: "object",
      properties: { input: { type: "string", description: "The raw tool input." } },
      required: ["input"],
    });
    expect(body.tools[1].description).toContain("start: begin_patch");
    expect(body.tool_choice).toBeUndefined();
    expect(tools.custom).toEqual(new Set(["apply_patch"]));
    expect(tools.namespaced.get("mcp__docs__search")).toEqual({ namespace: "mcp__docs", name: "search" });
    // Codex-backend-only fields never reach the Messages body.
    for (const field of ["include", "store", "prompt_cache_key", "input", "instructions", "reasoning"]) expect(body).not.toHaveProperty(field);
  });

  it("uses adaptive thinking for Claude models that require it, and keeps sampling without thinking", () => {
    const adaptive = responsesToMessages({ ...codexTurn, reasoning: { effort: "high" } }, { model: "claude-opus-5-5", stream: false }).body;
    expect(adaptive).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "high" }, stream: false });
    const plain = responsesToMessages(
      { ...codexTurn, reasoning: { effort: "none" }, temperature: 0.2, top_p: 0.9, max_output_tokens: 900, tool_choice: { type: "function", name: "shell" }, parallel_tool_calls: false },
      { model: MODEL, stream: true },
    ).body;
    expect(plain).toMatchObject({ temperature: 0.2, top_p: 0.9, max_tokens: 900, tool_choice: { type: "tool", name: "shell", disable_parallel_tool_use: true } });
    expect(plain).not.toHaveProperty("thinking");
  });

  it("converts nanocodex additional_tools input items into Messages tools", () => {
    const { body }: { body: Rec } = responsesToMessages(
      {
        model: "kimi-k3",
        input: [
          {
            type: "additional_tools",
            tools: [
              { type: "function", name: "exec_command", description: "Run.", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
              { type: "function", name: "write_stdin", parameters: { anyOf: [{ properties: { session_id: { type: "number" } } }, { properties: { chars: { type: "string" } } }] } },
            ],
          },
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
        stream: true,
      },
      { model: MODEL, stream: true },
    );
    expect(body.tools).toEqual([
      { name: "exec_command", description: "Run.", input_schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
      { name: "write_stdin", description: "", input_schema: { type: "object", properties: { session_id: { type: "number" }, chars: { type: "string" } } } },
    ]);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("maps tool-call ids both ways and repairs pairing: missing results, orphans, assistant tail", () => {
    const { body }: { body: Rec } = responsesToMessages(
      {
        input: [
          { role: "user", content: "go" },
          { type: "function_call", call_id: "call:weird/1", name: "shell", arguments: '{"command":["pwd"]}' },
          { type: "function_call", call_id: "call_ok", name: "shell", arguments: "not json" },
          { type: "function_call_output", call_id: "call:weird/1", output: "/work" },
          { type: "function_call_output", call_id: "call_ghost", output: "late" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        ],
      },
      { model: MODEL, stream: true },
    );
    const [, assistant, results, tail, cont] = body.messages;
    const weird = assistant.content[0].id;
    expect(weird).toMatch(/^call_weird_1_[0-9a-f]{8}$/u);
    expect(assistant.content).toEqual([
      { type: "tool_use", id: weird, name: "shell", input: { command: ["pwd"] } },
      { type: "tool_use", id: "call_ok", name: "shell", input: {} },
    ]);
    expect(results).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: weird, content: "/work" },
        { type: "tool_result", tool_use_id: "call_ok", content: "[missing tool_result for this tool_use in history]", is_error: true },
        { type: "text", text: "[tool_result without adjacent tool_use: call_ghost]\nlate" },
      ],
    });
    expect(tail).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }] });
    expect(cont).toEqual({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  });
});

describe("Messages -> Responses output", () => {
  it("turns a two-tool Anthropic stream into Codex-shaped Responses events and items", async () => {
    const events = await translateStream(twoTools);
    expect(events.map((e) => e.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    const completed = events.at(-1)!.response;
    expect(completed).toMatchObject({
      status: "completed",
      model: "gpt-6-sol",
      usage: { input_tokens: 2_000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 87, total_tokens: 2_087 },
    });
    expect(completed.id).toBe(events[0]!.response.id);
    const [reasoning, message, shell, patch] = completed.output;
    expect(reasoning).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: "List the files, then patch the README." }] });
    expect(decodeThinkingEnvelope(reasoning.encrypted_content)).toEqual({
      model: MODEL,
      thinking: "List the files, then patch the README.",
      signature: "c3ludGhldGljLXNpZ25hdHVyZS0x",
    });
    expect(message).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking the tree first." }] });
    expect(shell).toMatchObject({ type: "function_call", call_id: "toolu_syn_shell", name: "shell", arguments: '{"command":["ls","-la"]}', status: "completed" });
    expect(patch).toMatchObject({ type: "custom_tool_call", call_id: "toolu_syn_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" });
    // Each output_item.done carries the same item the terminal response lists.
    expect(events.filter((e) => e.type === "response.output_item.done").map((e) => e.item)).toEqual(completed.output);
  });

  it("replays its own thinking to the same model on the next turn and drops foreign reasoning", async () => {
    const output = (await translateStream(twoTools)).at(-1)!.response.output;
    const history = [
      ...codexTurn.input,
      { type: "reasoning", id: "rs_chatgpt", summary: [], encrypted_content: "gAAAAABchatgpt-opaque" },
      ...output,
      { type: "function_call_output", call_id: "toolu_syn_shell", output: "README.md" },
      { type: "custom_tool_call_output", call_id: "toolu_syn_patch", output: [{ type: "input_text", text: "Done!" }] },
    ];
    const next: Rec = responsesToMessages({ ...codexTurn, input: history }, { model: MODEL, stream: true }).body;
    expect(next.messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "List the files, then patch the README.", signature: "c3ludGhldGljLXNpZ25hdHVyZS0x" },
          { type: "text", text: "Checking the tree first." },
          { type: "tool_use", id: "toolu_syn_shell", name: "shell", input: { command: ["ls", "-la"] } },
          { type: "tool_use", id: "toolu_syn_patch", name: "apply_patch", input: { input: "*** Begin Patch\n*** End Patch" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_syn_shell", content: "README.md" },
          { type: "tool_result", tool_use_id: "toolu_syn_patch", content: [{ type: "text", text: "Done!" }] },
        ],
      },
    ]);
    // Another model cannot verify that signature: the thinking is dropped.
    const elsewhere = responsesToMessages({ ...codexTurn, input: history }, { model: "glm-5.3", stream: true }).body;
    expect(JSON.stringify(elsewhere.messages)).not.toContain("thinking");
    // The way back to a Responses upstream drops the gateway's reasoning items, keeps ChatGPT's.
    const back = fitReplay({ input: history }, "chatgpt").input as Rec[];
    expect(back.filter((item) => item.type === "reasoning").map((item) => item.id)).toEqual(["rs_chatgpt"]);
    expect(back).toHaveLength(history.length - 1);
  });

  it("restores namespaced tools and ends truncated, failed and cut-off streams correctly", async () => {
    const call = await translateStream(anthropicSse([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__docs__search", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]));
    expect(call.at(-1)).toMatchObject({
      type: "response.incomplete",
      response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "function_call", name: "search", namespace: "mcp__docs", arguments: "{}" }] },
    });
    const failed = await translateStream(anthropicSse([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 300000 tokens > 262144 maximum" } },
    ]));
    expect(failed.at(-1)).toMatchObject({ type: "response.failed", response: { status: "failed", error: { code: "context_length_exceeded" } } });
    const cut = await translateStream(anthropicSse([{ type: "message_start", message: { usage: {} } }]));
    expect(cut.at(-1)).toMatchObject({ type: "response.failed", response: { error: { code: "server_error" } } });
    // Compatible vendors may end after message_delta without message_stop.
    const noStop = await translateStream(anthropicSse([
      { type: "message_start", message: { usage: {} } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ]));
    expect(noStop.at(-1)).toMatchObject({ type: "response.completed" });
  });

  it("translates a non-streaming Messages response", () => {
    const { tools } = responsesToMessages(codexTurn, { model: MODEL, stream: false });
    const response: Rec = messagesJsonToResponses(
      {
        type: "message",
        content: [
          { type: "thinking", thinking: "plan", signature: "sig" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "Here." },
          { type: "tool_use", id: "toolu_2", name: "apply_patch", input: { input: "*** Begin Patch" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 },
      },
      { requestModel: "gpt-6-sol", upstreamModel: MODEL, tools },
    );
    expect(response).toMatchObject({
      object: "response",
      status: "completed",
      model: "gpt-6-sol",
      usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: "Here." }] },
        { type: "custom_tool_call", call_id: "toolu_2", name: "apply_patch", input: "*** Begin Patch" },
      ],
    });
    expect(decodeThinkingEnvelope(response.output[1].encrypted_content)).toEqual({ model: MODEL, redacted: "opaque" });
  });
});

describe("Messages -> Responses request for API keys", () => {
  it("keeps the output limit and sampling fields only for real Responses APIs", () => {
    const claude = { model: "claude-opus-5-5", max_tokens: 4_096, temperature: 0.3, top_p: 0.8, messages: [{ role: "user", content: "hi" }] };
    expect(messagesToResponses(claude, { model: "gpt-6-sol", keepSampling: true })).toMatchObject({ max_output_tokens: 4_096, temperature: 0.3, top_p: 0.8 });
    const chatgpt = messagesToResponses(claude, { model: "gpt-6-sol" });
    for (const field of ["max_output_tokens", "temperature", "top_p"]) expect(chatgpt).not.toHaveProperty(field);
  });
});
