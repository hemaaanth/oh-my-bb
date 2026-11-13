import { describe, expect, it } from "vitest";
import { pagesHost, WORKSPACE } from "./test-fakes.js";

const dirty = '<style>body{font:600 16px Inter;max-width:62rem}.callout{border-left:3px solid #fff}</style><main class="page">Check</main>';
const context = { threadId: "thr_a", projectId: "proj_test" };
describe("style check and publish boundaries", () => {
  it("fails registered agent and CLI checks with located CSS errors and preserves embedded/script failures", async () => {
    const { files, harness } = pagesHost();
    try {
      const goodUi = '<script type="text/openui-lang">root = Status("done")</script>';
      files.set(`${WORKSPACE}/bad.html`, dirty + goodUi);
      const tool = JSON.parse(String(await harness.behavior.callAgentTool("page_check", { code: dirty + goodUi, language: "app" }, context)));
      expect(tool).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ rule: "page-width", line: 1 })]) });
      expect(tool.report).toContain("OpenUI block 1");
      const cli = await harness.behavior.runCli(["check", "bad.html"], { ...context, cwd: WORKSPACE });
      expect(cli.exitCode).toBe(1); expect(cli.stdout).toMatch(/1:\d+ error: \[font-family\]/);
      const json = await harness.behavior.runCli(["check", "bad.html", "--json"], { ...context, cwd: WORKSPACE });
      expect(JSON.parse(json.stdout!).ok).toBe(false);
      for (const code of ['<style>.a{color:var(--bb-muted)}</style><script type="text/openui-lang">root = Missing()</script>', '<style data-pages-style="custom">body{color:#fff}</style><script>const x = ;</script>']) {
        expect(JSON.parse(String(await harness.behavior.callAgentTool("page_check", { code, language: "app" }, context))).ok).toBe(false);
      }
    } finally { await harness.lifecycle.dispose(); }
  });
  it("publishes warnings without changing identity or the public RPC schema", async () => {
    const { files, harness } = pagesHost();
    try {
      files.set(`${WORKSPACE}/bad.html`, dirty);
      const first = await harness.behavior.runCli(["publish", "bad.html", "--json"], { ...context, cwd: WORKSPACE });
      expect(first.exitCode).toBe(0);
      const published = JSON.parse(first.stdout!);
      expect(published.styleIssues).toEqual(expect.arrayContaining([expect.objectContaining({ file: "bad.html", rule: "raw-color" })]));
      const same = JSON.parse((await harness.behavior.runCli(["publish", "bad.html", "--json"], { ...context, cwd: WORKSPACE })).stdout!);
      expect(same).toMatchObject({ changed: false, version: { id: published.version.id, n: 1 }, styleIssues: published.styleIssues });
      const tool = String(await harness.behavior.callAgentTool("page_publish", { file: "bad.html" }, context));
      expect(tool).toContain("Style warnings — published"); expect(tool).toContain("unchanged: v1");
      expect(tool.indexOf("::page{")).toBeLessThan(tool.indexOf("Style warnings"));
      const rpc = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "bad.html" });
      expect(rpc).not.toHaveProperty("styleIssues");
      files.set(`${WORKSPACE}/bad.html`, dirty + "<p>Changed</p>");
      const changed = JSON.parse((await harness.behavior.runCli(["publish", "bad.html", "--json"], { ...context, cwd: WORKSPACE })).stdout!);
      expect(changed).toMatchObject({ changed: true, version: { n: 2 } });
      expect(changed.styleIssues).toHaveLength(published.styleIssues.length);
    } finally { await harness.lifecycle.dispose(); }
  });
  it("keeps large warning-heavy publishes successful with bounded JSON and unchanged identity", async () => {
    const { files, harness } = pagesHost();
    try {
      const source = '<main class="page">' + '<span style="color:#fff">x</span>'.repeat(12_000) + '</main>';
      files.set(`${WORKSPACE}/many.html`, source);
      const first = await harness.behavior.runCli(["publish", "many.html", "--json"], { ...context, cwd: WORKSPACE });
      expect(first.exitCode).toBe(0);
      const published = JSON.parse(first.stdout!);
      expect(published.page.id).toMatch(/^[\da-f-]{36}$/);
      expect(published.directive).toContain(`id="${published.page.id}"`);
      expect(published.styleIssues).toHaveLength(50);
      expect(published).toMatchObject({ styleIssuesTotal: 12_000, styleIssuesOmitted: 11_950 });
      const again = await harness.behavior.runCli(["publish", "many.html", "--json"], { ...context, cwd: WORKSPACE });
      expect(again.exitCode).toBe(0);
      expect(JSON.parse(again.stdout!)).toMatchObject({
        changed: false, page: { id: published.page.id }, version: { id: published.version.id, n: 1 },
        styleIssuesTotal: 12_000, styleIssuesOmitted: 11_950,
      });
      const human = String(await harness.behavior.callAgentTool("page_publish", { file: "many.html" }, context));
      expect(human).toContain(published.page.id);
      expect(human).toContain("11950 more style findings omitted.");
      const rpc = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "many.html" });
      expect(rpc).toMatchObject({ page: { id: published.page.id }, version: { id: published.version.id } });
      expect(rpc).not.toHaveProperty("styleIssues");
    } finally { await harness.lifecycle.dispose(); }
  });
  it("warns that a long hand-built page uses no components, before CSS findings", async () => {
    const { files, harness } = pagesHost();
    try {
      const sections = ["Accounts", "People", "Org charts"].map(h => `<h2>${h}</h2><table><tr><td>x</td></tr></table>`).join("");
      files.set(`${WORKSPACE}/report.html`, `<style>.stat{padding:8px}</style><main class="page">${sections}</main>`);
      const tool = String(await harness.behavior.callAgentTool("page_publish", { file: "report.html" }, context));
      expect(tool).toContain("Style warnings — published");
      expect(tool.indexOf("[no-components]")).toBeGreaterThan(tool.indexOf("::page{"));
      expect(tool.indexOf("[no-components]")).toBeLessThan(tool.indexOf("[custom-component] .stat"));
      files.set(`${WORKSPACE}/report.html`, `<main class="page">${sections}<script type="text/openui-lang">root = Callout("info", "Ok")</script></main>`);
      const fixed = JSON.parse((await harness.behavior.runCli(["publish", "report.html", "--json"], { ...context, cwd: WORKSPACE })).stdout!);
      expect(fixed.styleIssues).toEqual([]);
    } finally { await harness.lifecycle.dispose(); }
  });
  it("checks nested folder HTML but not escaped Markdown or generated PR reviews", async () => {
    const { files, harness } = pagesHost();
    try {
      files.set(`${WORKSPACE}/site/index.html`, '<main class="page">Home</main>');
      files.set(`${WORKSPACE}/site/nested/about.html`, dirty);
      const folder = JSON.parse((await harness.behavior.runCli(["publish", "site", "--json"], { ...context, cwd: WORKSPACE })).stdout!);
      expect(folder.styleIssues).toEqual(expect.arrayContaining([expect.objectContaining({ file: "nested/about.html" })]));
      files.set(`${WORKSPACE}/clean.md`, "# Example\n\n" + dirty);
      const markdown = JSON.parse((await harness.behavior.runCli(["publish", "clean.md", "--json"], { ...context, cwd: WORKSPACE })).stdout!);
      expect(markdown.styleIssues).toEqual([]);
      const review = await harness.behavior.callRpc("publishDocument", { producer: "pr-review", producerKey: "review:1", title: "Review", provenance: { threadId: "thr_a", projectId: "proj_test" }, document: { schema: "pr-review/v1", title: "Review", target: { kind: "pull-request", label: "PR #1", headSha: "abc1234" }, intent: "Check", summary: "No defects", verdict: "pass", coverage: { reviewed: ["src"], skipped: [], validation: [] }, findings: [] } });
      expect(review).not.toHaveProperty("styleIssues");
    } finally { await harness.lifecycle.dispose(); }
  });
});
