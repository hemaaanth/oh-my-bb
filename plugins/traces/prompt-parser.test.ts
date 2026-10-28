import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promptResultSchema } from "./prompt-contract";
import { parseProviderTranscript } from "./prompt-parser";
import { boundedLines, findTranscript } from "./prompt-host";

const claude = readFileSync(new URL("./fixtures/prompt-claude.jsonl", import.meta.url), "utf8").trim().split("\n");
const codex = readFileSync(new URL("./fixtures/prompt-codex.jsonl", import.meta.url), "utf8").trim().split("\n");
const scan = () => ({ bytesRead: 0, linesRead: 0, malformedLines: 0, oversizedLines: 0, limited: false });
const input = (provider: "claude-code" | "codex", call: number | null, reveal: boolean) => ({
  threadId: provider === "claude-code" ? "thr_kxvdvw5nsh" : "thr_mtpqihzx7a", provider,
  sessionId: provider === "claude-code" ? "c0b4f488-91b5-4306-8fbc-a13f76725dba" : "01a17b8a-d681-7962-a989-093329e58e6e",
  call, reveal,
});

describe("provider transcript extraction", () => {
  it("pairs Claude usage once per request, including 5m/1h cache splits", async () => {
    const result = await parseProviderTranscript(claude, input("claude-code", 1, false), scan());
    expect(promptResultSchema.parse(result)).toEqual(result);
    expect(result.status).toBe("available");
    expect(result.callCount).toBe(2);
    expect(result.selected?.system).toHaveLength(2);
    expect(result.selected?.tools.length).toBeGreaterThan(10);
    expect(result.selected?.injected.some((s) => s.label.includes("AGENTS.md"))).toBe(true);
    expect(result.selected?.system[0]?.text).toBeNull();
    expect(result.selected?.tools[0]?.description).toBeNull();
    expect(result.selected?.usage).toMatchObject({ inputTokens: 2, cacheReadTokens: 12331, cacheWriteTokens: 20534, outputTokens: 329 });
    expect(result.totals?.outputTokens).toBe(512); // Two requests, not the six repeated assistant blocks.
    expect(result.selected?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("shows an adjacent Claude diff and reveals only explicitly requested content", async () => {
    const hidden = await parseProviderTranscript(claude, input("claude-code", 2, false), scan());
    const shown = await parseProviderTranscript(claude, input("claude-code", 2, true), scan());
    expect(hidden.selected?.diff.previousCall).toBe(1);
    expect(hidden.selected?.diff.systemChanged).toBe(false);
    expect(shown.selected?.diff.injectedAdded).toContain("Tool call");
    expect(shown.selected?.system[0]?.text).toContain("redacted");
    expect(shown.selected?.tools[0]?.description).toContain("redacted");
    expect(JSON.stringify(hidden)).not.toContain("redacted prompt content");
  });

  it("reads Claude string-array system blobs and marks nontext blocks as unstored", async () => {
    const rows = claude.map((line) => JSON.parse(line));
    const first = rows.find((row) => row.type === "api-request");
    first.tail.push("fixture_string_blob", "fixture_nontext_blob", "fixture_long_blob");
    rows.push({ type: "api-request-blob", hash: "fixture_string_blob", message: { role: "system", content: ["Line A", "Line B"] } });
    rows.push({ type: "api-request-blob", hash: "fixture_nontext_blob", message: { role: "system", content: [{ type: "image" }] } });
    rows.push({ type: "api-request-blob", hash: "fixture_long_blob", message: { role: "system", content: ["x".repeat(110_000)] } });
    const result = await parseProviderTranscript(rows.map((row) => JSON.stringify(row)), input("claude-code", 1, true), scan());
    expect(result.selected?.injected.find((entry) => entry.id === "fixture_stri")?.text).toBe("Line A\nLine B");
    expect(result.selected?.injected.find((entry) => entry.id === "fixture_nont")?.chars).toBeNull();
    expect(result.selected?.injected.find((entry) => entry.id === "fixture_long")?.chars).toBe(110_000);
    expect(result.selected?.injected.find((entry) => entry.id === "fixture_long")?.truncated).toBe(true);
  });
  it("reads Codex base instructions, dynamic tools, developer context, and exact per-response usage", async () => {
    const result = await parseProviderTranscript(codex, input("codex", 2, false), scan());
    expect(promptResultSchema.parse(result)).toEqual(result);
    expect(result.callCount).toBe(4);
    expect(result.selected?.system[0]?.label).toBe("Base instructions");
    expect(result.selected?.tools.length).toBeGreaterThan(40);
    expect(result.selected?.injected.some((s) => s.label.includes("AGENTS.md"))).toBe(true);
    expect(result.selected?.usage?.cacheWrite5mTokens).toBeNull();
    expect(result.selected?.usage?.cacheWrite1hTokens).toBeNull();
    expect(result.selected?.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.selected?.contextWindowTokens).toBeGreaterThan(0);
    expect(result.selected?.durationMs).toBeNull(); // No API request-start timestamp in Codex JSONL.
    expect(result.selected?.diff.previousCall).toBe(1);
  });

  it("detects Codex base and tool changes without showing the later prompt for an earlier call", async () => {
    const rows = codex.map((line) => JSON.parse(line));
    const firstUsage = rows.findIndex((row) => row.type === "token_usage_record");
    rows.splice(firstUsage + 1, 0, { type: "session_meta", payload: { base_instructions: { text: "Changed base instructions" },
      dynamic_tools: [{ name: "NewTool", description: "New definition", inputSchema: { type: "object" } }] } });
    const lines = rows.map((row) => JSON.stringify(row));
    const before = await parseProviderTranscript(lines, input("codex", 1, true), scan());
    const after = await parseProviderTranscript(lines, input("codex", 2, true), scan());
    expect(before.selected?.system[0]?.text).not.toBe("Changed base instructions");
    expect(after.selected?.system[0]?.text).toBe("Changed base instructions");
    expect(after.selected?.diff.systemChanged).toBe(true);
    expect(after.selected?.diff.toolsAdded).toContain("NewTool");
    expect(after.selected?.diff.toolsRemoved.length).toBeGreaterThan(0);
  });
  it("marks a tool inventory beyond the response cap as partial", async () => {
    const rows = codex.map((line) => JSON.parse(line));
    const meta = rows.find((row) => row.type === "session_meta");
    meta.payload.dynamic_tools.push(...Array.from({ length: 80 }, (_, i) => ({ name: `ExtraTool${i}`, description: "fixture" })));
    const result = await parseProviderTranscript(rows.map((row) => JSON.stringify(row)), input("codex", 1, false), scan());
    expect(result.status).toBe("truncated");
    expect(result.scan.limited).toBe(true);
    expect(result.selected?.tools).toHaveLength(100);
  });
  it("reports absent calls and malformed/incomplete records without inventing data", async () => {
    const data = [...claude, '{"type":"api-request",broken', '{"unfinished":'];
    const stats = scan();
    const result = await parseProviderTranscript(data, input("claude-code", 999, false), stats);
    expect(result.status).toBe("unavailable");
    expect(result.selected).toBeNull();
    expect(result.callCount).toBe(2);
    expect(result.scan.malformedLines).toBe(2);
  });
});

const temp: string[] = [];
afterEach(() => { for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("bounded host transcript access", () => {
  it("finds exact session files without following a symlink or path traversal", async () => {
    const home = mkdtempSync(join(tmpdir(), "traces-host-")); temp.push(home);
    const id = "c0b4f488-91b5-4306-8fbc-a13f76725dba";
    const root = join(home, ".claude", "projects", "-sample"); mkdirSync(root, { recursive: true });
    const file = join(root, `${id}.jsonl`); writeFileSync(file, "{}\n");
    expect(await findTranscript(home, "claude-code", id)).toBe(file);
    expect(await findTranscript(home, "claude-code", "../../secrets")).toBeNull();
    rmSync(file); symlinkSync(join(home, "secret"), file);
    expect(await findTranscript(home, "claude-code", id)).toBeNull();
  });

  it("locates a Codex rollout by exact session ID under the date hierarchy", async () => {
    const home = mkdtempSync(join(tmpdir(), "traces-codex-")); temp.push(home);
    const id = "01a17b8a-d681-7962-a989-093329e58e6e";
    const dir = join(home, ".codex", "sessions", "2026", "10", "27"); mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-27T00-07-39-${id}.jsonl`); writeFileSync(file, "{}\n");
    writeFileSync(join(dir, "rollout-wrong-id.jsonl"), "{}\n");
    expect(await findTranscript(home, "codex", id)).toBe(file);
    expect(await findTranscript(home, "codex", "01a17b8a-d681-7962-a989-093329e58e6f")).toBeNull();
  });
  it("skips oversized lines and keeps reading later valid JSONL", async () => {
    const home = mkdtempSync(join(tmpdir(), "traces-lines-")); temp.push(home);
    const file = join(home, "test.jsonl");
    writeFileSync(file, `{"type":"first"}\n${"x".repeat(2 * 1024 * 1024 + 1)}\n{"type":"last"}`);
    const stats = scan();
    const lines: string[] = [];
    for await (const line of boundedLines(file, stats)) lines.push(line);
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["first", "last"]);
    expect(stats.oversizedLines).toBe(1);
    expect(stats.limited).toBe(true);
  });
});
