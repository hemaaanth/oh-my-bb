import { describe, expect, it } from "vitest";
import { extractOpenUiFences, scoreGuidanceReply, summarizeGuidanceRun, type GuidanceCase } from "./eval-guidance-score.js";
import cases from "./eval-guidance-cases.json";
const status: GuidanceCase = { id: "status", category: "status", request: "Status", evidence: "Blocked", families: [["Status"]], dryReply: "" };
const fence = (code: string) => `\`\`\`openui-lang\n${code}\n\`\`\``;

describe("guidance scorer", () => {
  it("reads complete longer fences without accepting nested code samples", () => {
    expect(extractOpenUiFences('````openui-lang\nroot = Status("done")\n````')).toEqual([{ code: 'root = Status("done")', complete: true }]);
    expect(extractOpenUiFences('````markdown\n```openui-lang\nroot = Status("done")\n```\n````')).toEqual([]);
    expect(extractOpenUiFences('```openui-lang\nroot = Status("done")')).toEqual([{ code: 'root = Status("done")', complete: false }]);
  });
  it.each([
    'Status("done") would fit here.',
    fence('unused = Status("done")\nroot = Text("Status in prose")'),
    fence('root = Code(\'Status("done")\')'),
    fence('root = Plan([{step:"ship"}])'),
    '```openui-lang\nroot = Status("done")',
    fence('root = Missing("Status")'),
    fence('root = Status("done")') + '\n' + fence('root = Missing()'),
  ])("does not count a mention, unreachable node, wrong family or invalid fence: %s", async reply => {
    expect((await scoreGuidanceReply(status, reply)).pass).toBe(false);
  });
  it("counts reachable components and requires all families", async () => {
    const reply = fence('root = Stack([Status("done"), Acceptance([{criterion:"unit",status:"pass"}])])');
    expect(await scoreGuidanceReply({ ...status, families: [["Status"], ["Acceptance"]] }, reply)).toMatchObject({ pass: true, components: ["Stack", "Status", "Acceptance"] });
    expect((await scoreGuidanceReply({ ...status, families: [["Status"], ["Tests"]] }, reply)).pass).toBe(false);
  });
  it("scores the negative control and keeps process failures in totals", async () => {
    const negative = { ...status, negative: true, families: [] };
    expect((await scoreGuidanceReply(negative, "Happy to help.")).pass).toBe(true);
    expect((await scoreGuidanceReply(negative, fence('root = Text("Hi")'))).pass).toBe(false);
    const failed = await scoreGuidanceReply(status, fence('root = Status("done")'), "timeout");
    const success = await scoreGuidanceReply(status, fence('root = Status("done")'));
    const summary = summarizeGuidanceRun([{ ...failed, variant: "baseline" }, { ...success, variant: "new" }]);
    expect(summary.variants.baseline).toMatchObject({ total: 1, passed: 0 });
    expect(summary.delta).toEqual({ passed: 1, passRate: 1 });
  });
  it("uses scoped fixture reads and rejects unknown/dynamic query defaults", async () => {
    const test = { ...status, families: [["Tests"]], fixtures: { "/eval/tests.json": '[{"name":"a","status":"passed"}]' } };
    expect((await scoreGuidanceReply(test, fence('d = Query("file", {path:"/eval/tests.json"}, {data:null})\nroot = Tests(d.data)'))).pass).toBe(true);
    for (const query of ['Query("file", {path:"/eval/missing.json"}, {data:[]})', 'Query("commits", {}, {commits:[]})', 'Query("file", {path: "/eval/" + "tests.json"}, {data:[]})']) {
      expect((await scoreGuidanceReply(test, fence(`d = ${query}\nroot = Tests(d.data)`))).pass).toBe(false);
    }
  });
  it("checks all 27 synthetic fixture answers without invoking a model", async () => {
    expect(cases).toHaveLength(27);
    for (const test of cases) expect(await scoreGuidanceReply(test, test.dryReply), test.id).toMatchObject({ pass: true, diagnostics: [] });
  });
});
