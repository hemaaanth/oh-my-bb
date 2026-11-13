// Guidance and audience structure adapted from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
import examples from "./spec/examples.json";

// Each row is a moment in an ordinary reply, not a data type: agents reach for UI when the moment matches.
export const GUIDANCE_COMPONENT_MAP = [
  { content: "explaining how something works, an architecture, flow or dependency", components: ["Diagram", "Mermaid"], note: "sequences, states, schemas → Mermaid; structure → Tree; order of events → Timeline" },
  { content: "comparing two or more options, tools or approaches", components: ["Compare", "Table"], note: "with a recommendation → Decision" },
  { content: "needing the user's choice, priorities, ratings or feedback", components: ["Form", "OptionCards", "Radio", "Checklist", "Rating", "Slider", "TextArea"], note: "never end on an open question that these could answer" },
  { content: "likely next asks", components: ["FollowUps"], note: "2-4 prompts at the end; multiple true when the reader may want several" },
  { content: "numbers, trends, shares, limits", components: ["Stats", "Chart", "Sparkline", "SegmentedBar", "Gauge"], note: "Stats takes Stat(...) calls, not objects" },
  { content: "how-to, setup with a current step, or a key caveat", components: ["Steps", "Snippet", "Callout"] },
  { content: "status or readiness with two or more checks", components: ["Status", "Acceptance", "Provenance"], note: "one fence, next actions in Status.next; pass/fail or before/after checks → Acceptance, not Table; build/run identity → Provenance; not a default layout" },
  { content: "plans, effort, schedules", components: ["Plan", "Estimate", "Roadmap", "Board", "Calendar"], note: "phases across lanes → Roadmap" },
  { content: "tests, lint, logs, CI jobs, exceptions, timings", components: ["Tests", "Findings", "Logs", "Pipeline", "StackTrace", "Benchmark"], note: "never paste raw output" },
  { content: "code, diffs, files, git", components: ["FileCode", "Diff", "Changes", "Commits", "PullRequest"] },
  { content: "alternatives or optional depth", components: ["Tabs", "Details"] },
  { content: "teaching, visuals, places, sources", components: ["Walkthrough", "Quiz", "Flashcards", "BeforeAfter", "App", "Map", "Sources"] },
] as const;
const COMPONENT_MAP_TEXT = GUIDANCE_COMPONENT_MAP.map(group => `- ${group.content} → ${group.components.join(", ")}${"note" in group ? `; ${group.note}` : ""}`).join("\n");
export const QUICK_COMPONENTS = ["Stack", "Stats", "Stat", "Table", "Status", "Plan", "Acceptance", "Decision", "Form", "Choice", "Toggle", "Button", "Diagram", "Mermaid", "Compare", "OptionCards", "Checklist", "FollowUps", "Chart", "Series", "Callout", "Tabs", "Tab"] as const;
const QUICK_SIGNATURES = QUICK_COMPONENTS.map(name => examples.find(entry => entry.name === name)!.signature).join("\n");

export const PAGES_GUIDANCE = `# Pages in BB
Replies render in BB as UI, not terminal text. Show, don't tell: when a reply explains, compares, measures, plans or asks, render that part as an openui-lang fence and keep prose for the story. Expect UI in at least a quarter of replies. Before any reply longer than a few sentences, ask: would a diagram, table, chart or form show this better? Skip UI only for a one-line answer, plain conversation or an explicit text-only request. "No tools" allows a fence: it is not a tool call. Never use markdown tables, ASCII diagrams, status bullets or pasted output where a component fits.
Pick by moment. Mix several in one Stack and vary them; do not reuse one layout every time:
${COMPONENT_MAP_TEXT}
The catalog has over 100 components. When a moment fits none of these, page_examples with no names lists them all; do not settle for text. Quick signatures cover the common ones, so skip page_examples and page_check for known-valid fences, and always when told not to use tools.
Reply UI needs no file or publish. Publish long documents to keep or share; copy the returned ::page directive exactly on its own line. Reply Forms send answers; saved OpenUI Forms are read-only. For HTML follow the page_publish style rules.
Inline supplied data. Query("file") is only for existing workspace files, never invented paths or results. Examples below are illustrative. Each fence opens with \`\`\`openui-lang, closes with \`\`\`, and holds a complete root = Component(...) program.
\`\`\`openui-lang
root = Diagram([{id: "ui", label: "Web app"}, {id: "api", label: "API"}, {id: "q", label: "Queue", tone: "info"}, {id: "db", label: "Postgres"}], [{from: "ui", to: "api"}, {from: "api", to: "db", label: "reads"}, {from: "api", to: "q", label: "jobs"}, {from: "q", to: "db", label: "writes"}], "right")
\`\`\`
\`\`\`openui-lang
root = Compare(["Vitest", "Jest"], [{criterion: "Cold run (s)", values: [1.2, 4.8], better: "low"}, {criterion: "ESM", values: ["Native", "Flag"]}], "Vitest")
\`\`\`
\`\`\`openui-lang
form = Form("next", [OptionCards("focus", [{label: "Speed", icon: "zap", detail: "Cut cold start first"}, {label: "Polish", icon: "sparkles", detail: "Fix the rough UI edges"}], "What matters most?"), TextArea("notes", "Anything else?")], [Button("Send")])
more = FollowUps(["Show the slow paths", "Draft the plan"])
root = Stack([form, more])
\`\`\`
Before sending: could a component show this better than prose? Is every comparison a table, every flow a diagram, every question a form? Real data only; unknown checks stay unknown.`;

export const CODE_WORK_INSTRUCTIONS = `# Pages code-work reference
Replies render in BB; a fitting component beats a markdown table.
Inline supplied data. Read existing saved reports rather than pasting or retyping output. State conclusions and unverified limits in prose. Query("file") needs an existing workspace file; never copy illustrative paths as evidence.
Query("file", {path: "..."}, {data: null, text: ""}) returns .data for JSON and .text for logs, XML and LCOV. CSV/TSV/JSONL use .rows. Query is read-only; a default is not proof that the file was read.
- tests → Tests(report): Vitest/Jest JSON or JUnit XML. Save Vitest with --reporter=json --outputFile=<path>.
- compiler / lint / review → Findings(report): tsc --noEmit --pretty false text, ESLint/Ruff JSON, SARIF, or observed review rows.
- build / server output → Logs(text, title?, wrap?); exceptions → StackTrace(text).
- coverage → Coverage(report): coverage-summary.json or lcov.info text.
- timings → Benchmark(rows): [{name,before,after,unit}]; hyperfine JSON also works. Keep conditions and uncertainty.
- CI → Pipeline(data): gh run view <id> --json jobs.
- dependencies → Dependencies(data): npm outdated/audit JSON. API response → Json(data).
- traces → Waterfall(data); sizes → Treemap(rows).
- uncommitted files: c = Query("changes", {}, {files: []}); show Changes(c.files).
- branch commits: c = Query("commits", {}, {commits: []}); show Commits(c.commits).
- branch PR: p = Query("pull_request", {}, {pullRequest: null, message: "Loading"}); show PullRequest(p.pullRequest, p.message).
- code → FileCode(path, from?, to?) reads actual source; Snippet(text, label?) only copies supplied text. Diff(patch, file) needs a unified diff.
- project state → Query("threads") / Query("environments"), then Threads(data.threads) / Environments(data.environments).
These are expressions to place in a complete root program, not zero-argument project components. Never use GenUI's Load or its different component signatures.
Illustrative example:
\`\`\`openui-lang
root = Stack([Benchmark([{name: "Build", before: 12, after: 8, unit: "s"}], "Illustrative timings"), Findings([{severity: "high", title: "Retry loses payload", file: "src/queue.ts", line: 88, detail: "Only the id is requeued"}], "Illustrative review")])
\`\`\`
page_check checks syntax and independent input states; it does not prove browser rendering or security. For HTML it also reports author style issues; explicit custom-style opt-outs do not disable script/sandbox checks.`;

export const EXAMPLES_INSTRUCTIONS = `# Pages quick signatures
Replies render in BB; a fitting component beats a markdown table.
Use page_examples when unsure of a component's signature or data shape. Use page_check when unsure of validity; neither is required before every fence.
Syntax: one assignment per line; root is the visible entry point. Arguments are positional. $name declares local state; bindings use $name. Use null to skip an optional positional argument. Do not use GenUI named arguments or Load(). ? below means optional; it is not program syntax.
${QUICK_SIGNATURES}
A Button without an action sends its label and Form answers. Ask with a Form (OptionCards, Checklist, Rating) instead of an open question; end with FollowUps when next steps are likely. A named Decision sends the choice; omit name for a read-only recommendation. Saved OpenUI forms are read-only.
Illustrative example:
\`\`\`openui-lang
root = Form("export", [Choice("format", ["CSV", "JSON"], "Format"), Toggle("headers", "Include headers")], [Button("Send")])
\`\`\`
Use the catalog for other signatures, not invented names. page_examples with no names lists the catalog; named calls include worked examples. Start with the fitting component, not custom HTML.`;

export const PUBLISH_INSTRUCTIONS = `# Publishing Pages
Replies render in BB; a fitting component beats a markdown table.
Publish a long document to keep or share. Direct reply UI needs only an openui-lang fence. Copy the returned ::page directive exactly onto its own line. The page is visible there; do not announce, describe or restate it.
Use display: "inline" for one chart, small table, diagram, stat row or form. Keep the default card for tabs, a contents list or several sections. An HTML form defaults to inline unless display is given. Saved OpenUI answer controls are read-only.
Use body.auto and main.page, .page.wide or .page.dashboard. Keep theme typography, colours and page widths. Prefer .note, .meta-line, .badge, .scroll, .grid and var(--bb-text), var(--bb-muted), var(--bb-surface), var(--bb-rule), var(--bb-positive), var(--bb-negative), var(--bb-warning). Do not add base-element resets, fonts, bold styling, raw colours, gradients, left rails or uppercase tracked eyebrows.
Only art/mockups may opt out: data-pages-style="custom" on each <style> block or inline-styled element. Keep selectors within the mockup. The attribute waives style lint only. Publication succeeds with style warnings; fix the source or justify a scoped opt-out. page_check reports issues before publication. Use page_examples/page_check when unsure, not before every known-valid reply fence. Use page_browse to find prior artifacts in fresh threads.`;

export const WORKER_INSTRUCTIONS = "This thread returns to an agent. Use plain text for handoffs. Pages tools remain available for explicitly requested artifacts; do not add reply UI proactively.";

export function isPersonReadThread(context: { pluginMetadata: unknown; thread: { parentThreadId: string | null }; origin: { pluginId: string | null } }): boolean {
  const metadata = context.pluginMetadata;
  const audience = metadata && typeof metadata === "object" && !Array.isArray(metadata) && "audience" in metadata ? metadata.audience : undefined;
  if (audience === "person") return true;
  if (audience === "agent") return false;
  return context.thread.parentThreadId === null && (context.origin.pluginId === null || context.origin.pluginId === "side-chat");
}
