// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Renderer } from "@openuidev/react-lang";
import { specLibrary } from "../catalog.js";
import {
  byStage, formatAmount, formatElapsed, formatPercent, frameRows, levelOf, niceTicks, overallStatus, readBenchmark, readCoverage, readDependencies, readFindings, readLogs, readPipeline, readTiles, readTrace,
  readWaterfall, splitChange, textLevel, treemapPoints, verdictOf, versionBump, visibleTiles,
} from "./dev-logic.js";

afterEach(cleanup);

describe("dev logic", () => {
  it("formats amounts and ticks", () => {
    expect([formatAmount(0.0277, "ms"), formatAmount(349438, "B"), formatAmount(36074, "ops/s"), formatAmount(4210, "$"), formatAmount(12.5, "%"), formatAmount(1234567)]).toEqual(["27.7 µs", "341 KB", "36.1K ops/s", "$4,210", "12.5%", "1,234,567"]);
    expect(niceTicks(0, 412)).toEqual([0, 100, 200, 300, 400, 500]);
    expect([formatElapsed(0), formatElapsed(400), formatElapsed(95_000), formatElapsed(3_900_000)]).toEqual(["0s", "<1s", "1m 35s", "1h 05m"]);
  });

  it("reads benchmarks and their verdicts", () => {
    expect([verdictOf(10, 8, "lower", null), verdictOf(10, 10.05, "lower", null), verdictOf(10, 11, "lower", 2), verdictOf(10, 12, "higher", null)]).toEqual(["better", "same", "same", "better"]);
    expect(readBenchmark({ results: [{ command: "a", mean: 0.3, stddev: 0.01 }] })).toEqual([{ name: "a", before: null, after: 0.3, unit: "s", better: "lower", noise: 0.01 }]);
    expect(readBenchmark([{ name: "throughput", before: 100, value: 120 }, { name: "half" }])[0]).toMatchObject({ better: "higher", before: 100, after: 120 });
  });

  it("reads coverage summaries", () => {
    const read = readCoverage({ total: { lines: { total: 10, covered: 8, pct: 80 } }, "/w/a/x.ts": { lines: { total: 4, covered: 4 } }, "/w/a/y.ts": { lines: { total: 6, covered: 4 } } });
    expect(read.total).toMatchObject({ covered: 8, total: 10 });
    expect(read.files.map((file) => file.path)).toEqual(["y.ts", "x.ts"]);
    expect([formatPercent(999, 1000), formatPercent(9995, 10000), formatPercent(1, 100000), formatPercent(0, 0)]).toEqual(["99.9%", "99.9%", "<0.1%", "—"]);
    expect(readCoverage([{ path: "a", pct: 50 }]).total?.pct).toBe(50);
  });

  it("reads versions", () => {
    expect([versionBump("19.0.2", "20.1.0"), versionBump("4.0.5", "4.1.3"), versionBump("1.0.0-beta.1", "1.0.0-beta.3"), versionBump("1.2.3", "1.2.3"), versionBump("x", "1")]).toEqual(["major", "minor", "prerelease", null, null]);
    expect([splitChange("4.17.15", "4.18.1"), splitChange("1.0.0-beta.1", "1.0.0-beta.3"), splitChange("1.0", "2.0")]).toEqual([["4.", "18.1"], ["1.0.0-beta.", "3"], ["", "2.0"]]);
    expect(readDependencies({ b: { current: "1.0.0", latest: "1.0.1" }, a: { current: "1.0.0", latest: "2.0.0" } }).map((item) => [item.name, item.bump])).toEqual([["a", "major"], ["b", "patch"]]);
  });

  it("reads findings and SARIF", () => {
    expect(readFindings([{ severity: "note", message: "n" }, { severity: "error", title: "e", file: "a.ts", line: 3 }, { severity: "x" }]).map((item) => [item.severity, item.title])).toEqual([["high", "e"], ["low", "n"]]);
    expect(readFindings({ runs: [{ results: [{ ruleId: "r", level: "warning", message: { text: "w" }, locations: [{ physicalLocation: { artifactLocation: { uri: "b.ts" }, region: { startLine: 9 } } }] }] }] })).toEqual([{ severity: "medium", title: "w", file: "b.ts", line: 9, rule: "r", detail: undefined, code: undefined }]);
  });

  it("reads log levels, continuations, and repeats", () => {
    expect([levelOf(50), levelOf(3), levelOf("WARNING"), textLevel("level=debug msg=x"), textLevel("[warn] hi"), textLevel("src/a.ts(1,2): error TS2532: no"), textLevel("2026 INFO ok"), textLevel("info about errors")]).toEqual(["error", "error", "warn", "debug", "warn", "error", "info", null]);
    const lines = readLogs("\u001b[31mERROR boom\u001b[0m\n    at x (a.js:1:1)\nok\nok\n");
    expect(lines.map((line) => [line.text, line.level, line.count])).toEqual([["ERROR boom", "error", 1], ["    at x (a.js:1:1)", "error", 1], ["ok", null, 2]]);
    expect(readLogs(['{"level":40,"msg":"slow"}'])[0]).toMatchObject({ text: "slow", level: "warn" });
  });

  it("reads pipelines", () => {
    expect([overallStatus(["success", "failure"]), overallStatus(["success", "queued"]), overallStatus(["queued"]), overallStatus(["skipped"]), overallStatus([])]).toEqual(["failure", "in_progress", "queued", "skipped", "neutral"]);
    const jobs = readPipeline({ jobs: [{ name: "a", status: "completed", conclusion: "success", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z" }, { name: "b", status: "completed", conclusion: "failure" }, { name: "c", status: "in_progress" }] });
    expect(jobs.map((job) => [job.name, job.status, job.ms])).toEqual([["a", "success", 60000], ["b", "failure", undefined], ["c", "in_progress", undefined]]);
    expect(byStage(jobs)[0].jobs.map((job) => job.name)).toEqual(["b", "c", "a"]);
  });

  it("reads JavaScript, Python, and Java traces", () => {
    const js = readTrace("TypeError: x is undefined\n    at f (/app/src/a.ts:3:5)\n    at g (/app/node_modules/r/i.js:1:1)\n    at h (node:internal/x:2:2)\n    at main (/app/src/b.ts:9:1)\n  [cause]: Error: inner\n    at k (/app/src/c.ts:1:1)");
    expect(js.map((section) => [section.type, section.message, section.frames.length, section.cause])).toEqual([["TypeError", "x is undefined", 4, false], ["Error", "inner", 1, true]]);
    expect(frameRows(js[0].frames, new Set()).map((item) => "folded" in item ? item.folded : item.frame.fn)).toEqual(["f", 2, "main"]);
    const py = readTrace('Traceback (most recent call last):\n  File "/app/main.py", line 4, in <module>\n    main()\n  File "/app/o.py", line 7, in total\n    return x["p"]\nKeyError: \'p\'');
    expect(py[0]).toMatchObject({ type: "KeyError", message: "'p'" });
    expect(py[0].frames.map((frame) => [frame.fn, frame.code])).toEqual([["total", 'return x["p"]'], ["<module>", "main()"]]);
    const java = readTrace("java.lang.IllegalStateException: no\n\tat com.acme.Cart.total(Cart.java:12)\n\tat java.base/java.util.ArrayList.forEach(ArrayList.java:1)\nCaused by: java.io.IOException: disk");
    expect(java.map((section) => [section.type, section.frames.map((frame) => frame.app)])).toEqual([["java.lang.IllegalStateException", [true, false]], ["java.io.IOException", []]]);
    expect(readTrace({ name: "Error", message: "plain" })).toMatchObject([{ type: "Error", message: "plain" }]);
  });

  it("lays out treemaps", () => {
    expect(treemapPoints([{ name: "a", value: 2 }, { name: "b", value: 1 }])).toEqual([{ name: "a", value: 2, colorIndex: 0 }, { name: "b", value: 1, colorIndex: 0 }]);
    expect(treemapPoints([{ name: "a", value: 2, group: "x" }, { name: "b", value: 3, group: "y" }])).toEqual([
      { id: "group-0", name: "y", colorIndex: 2 }, { parent: "group-0", name: "b", value: 3, colorIndex: 2 },
      { id: "group-1", name: "x", colorIndex: 0 }, { parent: "group-1", name: "a", value: 2, colorIndex: 0 },
    ]);
    const tiles = visibleTiles(Array.from({ length: 30 }, (_, i) => ({ name: String(i), value: 30 - i })));
    expect([tiles.length, tiles[tiles.length - 1].name]).toEqual([24, "7 more"]);
    expect(readTiles({ a: 2, b: 0 })).toEqual([{ name: "a", value: 2 }]);
  });

  it("reads waterfalls from spans and HAR files", () => {
    expect(readWaterfall([{ name: "a", start: 1, end: 3, depth: 1 }, { name: "b", start: 2, duration: 1, status: "error" }], "s")).toEqual([{ name: "a", start: 0, duration: 2000, depth: 1, failed: false, detail: undefined }, { name: "b", start: 1000, duration: 1000, depth: 0, failed: true, detail: undefined }]);
    const har = readWaterfall({ log: { entries: [{ startedDateTime: "2026-01-01T00:00:00.000Z", time: 10, request: { url: "https://x.com/" }, response: { status: 200 } }, { startedDateTime: "2026-01-01T00:00:00.050Z", time: 5, request: { url: "https://x.com/a.js?v=1" }, response: { status: 404 } }] } });
    expect(har.map((span) => [span.name, span.start, span.failed])).toEqual([["x.com", 0, false], ["/a.js?v=1", 50, true]]);
  });
});

describe("dev components", () => {
  it("survive partial props while streaming", () => {
    render(<Renderer response={'root = Stack([Pipeline([{name: "lint", status: "success"}, {na'} library={specLibrary} isStreaming />);
    expect(screen.getByText("lint")).toBeTruthy();
  });
});
