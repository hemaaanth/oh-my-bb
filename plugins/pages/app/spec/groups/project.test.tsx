// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Renderer } from "@openuidev/react-lang";
import { specLibrary } from "../catalog.js";
import { fixtureTools } from "../kit.js";
import { group } from "./project.js";
import { groupTests, jsonChildren, jsonPreview, readTests, relativeTime, testCounts, testStatus } from "./project-logic.js";

afterEach(cleanup);

describe("project logic", () => {
  const now = Date.parse("2026-06-15T12:00:00Z");
  it("says how long ago", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4 days ago");
    expect(relativeTime("nope", now)).toBe("");
  });

  it("reads status words", () => {
    expect([testStatus("PASS"), testStatus("timed-out"), testStatus("todo"), testStatus(false), testStatus("maybe")]).toEqual(["passed", "failed", "skipped", "failed", null]);
  });

  it("reads lists, groups, vitest JSON, and JUnit XML", () => {
    expect(readTests([{ name: "a", status: "ok" }, { name: "half" }, { suite: "s", tests: [{ title: "b", passed: false, error: { message: "boom" } }] }])).toEqual([
      { name: "a", status: "passed", suite: undefined, file: undefined, ms: undefined, message: undefined },
      { name: "b", status: "failed", suite: "s", file: undefined, ms: undefined, message: "boom" },
    ]);
    expect(readTests({ testResults: [{ name: "x.test.ts", assertionResults: [{ title: "t", ancestorTitles: ["A", "B"], status: "pending", duration: 2 }] }] })).toEqual([{ name: "t", status: "skipped", suite: "A › B", file: "x.test.ts", ms: 2, message: undefined }]);
    const xml = readTests('<testsuite name="S"><testcase name="ok" time="0.5"/><testcase name="bad"><failure message="m">trace</failure></testcase><testcase name="skip"><skipped/></testcase></testsuite>');
    expect(xml.map((test) => [test.name, test.status, test.suite, test.ms, test.message])).toEqual([["ok", "passed", "S", 500, undefined], ["bad", "failed", "S", undefined, "trace"], ["skip", "skipped", "S", undefined, undefined]]);
    expect(readTests("<oops")).toEqual([]);
    expect(readTests(42)).toEqual([]);
  });

  it("counts and groups failures first", () => {
    const cases = readTests([{ name: "a", status: "passed", suite: "x" }, { name: "b", status: "passed", suite: "y" }, { name: "c", status: "failed", suite: "y" }]);
    expect(testCounts(cases)).toEqual({ passed: 2, failed: 1, skipped: 0 });
    expect(groupTests(cases).map((group) => [group.suite, group.cases[0].name, group.failed])).toEqual([["y", "c", 1], ["x", "a", 0]]);
  });

  it("previews JSON", () => {
    expect([jsonPreview([1]), jsonPreview({ a: 1, b: 2 }), jsonPreview("x"), jsonPreview(null)]).toEqual(["[1 item]", "{2 keys}", '"x"', "null"]);
    expect(jsonChildren(["a"])).toEqual([["0", "a"]]);
  });
});

describe("project components", () => {
  it("render Query results from the fixtures", async () => {
    const example = (name: string) => group.entries.flatMap((entry) => entry.examples).find((item) => item.name === name && item.tools)!;
    render(<Renderer response={example("From the thread").code} library={specLibrary} isStreaming={false} toolProvider={fixtureTools(example("From the thread").tools)} />);
    expect(await screen.findByText("src/total.ts")).toBeTruthy();
  });

  it("survive partial props while streaming", () => {
    render(<Renderer response={'root = Stack([Changes([{path: "a.ts", additions: 1}, {pa'} library={specLibrary} isStreaming />);
    expect(screen.getByText("a.ts")).toBeTruthy();
  });
});
