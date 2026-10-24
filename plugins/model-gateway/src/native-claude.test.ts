import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { bindNativeAccount, prepareNativeClaude, remapNativeResponse, NativeClaudeError } from "./native-claude.js";

const command = fileURLToPath(new URL("./fixtures/native-claude-cli.mjs", import.meta.url));
const model = "claude-opus-5-5";
const encode = (body: object) => new TextEncoder().encode(JSON.stringify(body));
const body = { model, stream: true, max_tokens: 4096, speed: "fast", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
const selected = (overrides: Partial<typeof body> = {}) => prepareNativeClaude({ body: encode({ ...body, ...overrides }), model, streaming: true, command, signal: new AbortController().signal });

describe("native Claude Code request construction", () => {
  it("captures one native request with CLI headers, no child OAuth, and model controls", async () => {
    const native = await selected();
    const request = JSON.parse(new TextDecoder().decode(native.body));
    expect(native.headers.get("authorization")).toBeNull();
    expect(native.headers.get("x-app")).toBe("cli");
    expect(native.headers.get("anthropic-beta")).toContain("claude-code");
    expect(request.messages.map((message: { role: string }) => message.role)).toEqual(["user", "system"]);
    expect(request.system).toEqual([{ type: "text", text: "Native CLI system" }]);
    expect(request.max_tokens).toBe(4096);
    expect(request.speed).toBe("fast");
    expect(request.stream).toBe(true);
    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
  });

  it("binds empty CLI identity without changing native session and device IDs", async () => {
    const native = await selected();
    const bound = JSON.parse(new TextDecoder().decode(bindNativeAccount(native.body, "11111111-1111-4111-8111-111111111111")));
    expect(JSON.parse(bound.metadata.user_id)).toEqual({
      account_uuid: "11111111-1111-4111-8111-111111111111",
      session_id: "22222222-2222-4222-8222-222222222222",
      device_id: "device-native",
    });
    expect(bindNativeAccount(native.body, null)).toBe(native.body);
  });

  it("preserves explicit thinking, tool choice and nonstream semantics", async () => {
    const native = await prepareNativeClaude({ body: encode({ ...body, thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: "high" }, tool_choice: { type: "none" } }), model, streaming: false, command, signal: new AbortController().signal });
    const request = JSON.parse(new TextDecoder().decode(native.body));
    expect(request).toMatchObject({ thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: "high" }, tool_choice: { type: "none" }, stream: false });
  });

  it("restores signed thinking across tool replay without replacing native user/system messages", async () => {
    const request = { ...body, tools: [{ name: "functions__run", description: "run", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      tool_choice: { type: "tool", name: "functions__run" },
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "proof", signature: "signed-value" }, { type: "tool_use", id: "toolu_prev", name: "functions__run", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_prev", content: "done" }] },
      ] };
    const native = await prepareNativeClaude({ body: encode(request), model, streaming: false, command, signal: new AbortController().signal });
    const sent = JSON.parse(new TextDecoder().decode(native.body));
    expect(sent.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(sent.messages[1].content).toEqual([{ type: "thinking", thinking: "proof", signature: "signed-value" }, { type: "tool_use", id: "toolu_prev", name: "mcp__gateway__tool_0", input: { path: "a" } }]);
    expect(sent.messages[2].content[0].tool_use_id).toBe("toolu_prev");
    expect(sent.tool_choice).toEqual({ type: "tool", name: "mcp__gateway__tool_0" });
    expect(sent.stream).toBe(false);
    expect(native.names.get("mcp__gateway__tool_0")).toBe("functions__run");
  });

  it("delivers first SSE frame before the upstream finishes and remaps native tool names", async () => {
    const names = new Map([["mcp__gateway__tool_0", "functions__run"]]);
    let complete!: () => void;
    const wait = new Promise<void>(resolve => { complete = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"type":"message"}}\n\n'));
        void wait.then(() => {
          controller.enqueue(new TextEncoder().encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"mcp__gateway__tool_0"}}\n\n'));
          controller.close();
        });
      },
    });
    const response = remapNativeResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), names);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("message_start");
    complete();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain('"name":"functions__run"');
    await reader.cancel();
  });

  it("remaps nonstream tool calls and rejects undeclared tool calls", async () => {
    const names = new Map([["mcp__gateway__tool_0", "run"]]);
    const reply = { content: [{ type: "tool_use", name: "mcp__gateway__tool_0", id: "a" }] };
    expect(await remapNativeResponse(Response.json(reply), names).json()).toEqual({ content: [{ type: "tool_use", name: "run", id: "a" }] });
    await expect(remapNativeResponse(Response.json({ content: [{ type: "tool_use", name: "alien" }] }), names).text()).rejects.toThrow("outside the current inventory");
  });

  it("fails closed when CLI is missing or history tools are not declared", async () => {
    await expect(prepareNativeClaude({ body: encode(body), model, streaming: true, command: "/nonexistent/claude", signal: new AbortController().signal })).rejects.toThrow("unavailable");
    const invalid = { ...body, messages: [{ role: "user", content: [{ type: "text", text: "first" }] }, { role: "assistant", content: [{ type: "tool_use", name: "unknown", id: "a", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "x" }] }] };
    await expect(prepareNativeClaude({ body: encode(invalid), model, streaming: true, command, signal: new AbortController().signal })).rejects.toThrow(NativeClaudeError);
  });

  it("does not capture a request after an errored historical replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-reject-"));
    const marker = join(dir, "marker");
    try {
      const messages = [
        { role: "user", content: [{ type: "text", text: `reject-native-replay:${marker}` }] },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ];
      await expect(selected({ messages })).rejects.toThrow("rejected history replay");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects when the CLI closes stdin between replay frames", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "close-native-stdin" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    await expect(selected({ messages })).rejects.toThrow(/stdin|exited|did not submit/u);
  });

  it("terminates inherited CLI descendants before returning the captured request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-descendant-"));
    const marker = join(dir, "marker");
    try {
      await selected({ messages: [{ role: "user", content: [{ type: "text", text: `descendant-marker:${marker}` }] }] });
      const initial = await readFile(marker, "utf8");
      expect(initial).toMatch(/^\d+:started/u);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await readFile(marker, "utf8")).toBe(initial);
    } finally {
      const pid = Number((await readFile(marker, "utf8").catch(() => "0")).split(":")[0]);
      if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps waiting workers and removes an aborted queued request without spawning it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-queue-"));
    const controllers: AbortController[] = [];
    const operations: Array<Promise<unknown>> = [];
    const start = (index: number) => {
      const controller = new AbortController();
      controllers.push(controller);
      const marker = join(dir, `worker-${index}`);
      const promise = prepareNativeClaude({
        body: encode({ ...body, messages: [{ role: "user", content: [{ type: "text", text: `stall-native-worker worker-start-marker:${marker}` }] }] }),
        model, streaming: true, command, signal: controller.signal,
      });
      operations.push(promise);
      void promise.catch(() => {});
      return { controller, marker, promise };
    };
    try {
      const active = [0, 1, 2, 3].map(start);
      await vi.waitFor(async () => {
        for (const worker of active) expect(await readFile(worker.marker, "utf8")).toBe("started");
      }, { timeout: 5000 });
      const queued = start(4);
      queued.controller.abort();
      await expect(queued.promise).rejects.toBeDefined();
      await expect(readFile(queued.marker)).rejects.toMatchObject({ code: "ENOENT" });
      const overflow = Array.from({ length: 17 }, (_, index) => start(index + 5).promise);
      const first = await Promise.race(overflow.map(promise => promise.then(() => null, error => error)));
      expect(first).toBeInstanceOf(NativeClaudeError);
      expect((first as Error).message).toContain("capacity is exhausted");
    } finally {
      controllers.forEach(controller => controller.abort());
      await Promise.allSettled(operations);
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("terminates a stalled CLI on cancellation", async () => {
    const controller = new AbortController();
    const pending = prepareNativeClaude({ body: encode({ ...body, messages: [{ role: "user", content: [{ type: "text", text: "stall-native-worker" }] }] }), model, streaming: true, command, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toBeDefined();
  });
});
