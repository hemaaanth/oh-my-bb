// Guidance and audience structure adapted from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
import examples from "./spec/examples.json";

export const GUIDANCE_COMPONENT_MAP = [
  {
    "content": "status / checks / evidence",
    "components": [
      "Status",
      "Acceptance",
      "Provenance"
    ],
    "note": "Pass/fail or before/after checks: Acceptance, not Table; build/run identity: Provenance."
  },
  {
    "content": "plans / steps / phases / tasks / effort",
    "components": [
      "Plan",
      "Steps",
      "Roadmap",
      "Board",
      "Estimate"
    ],
    "note": "Ordered setup with a current step: Steps; phases across lanes/quarters: Roadmap."
  },
  {
    "content": "options / comparisons / decisions / rows and columns",
    "components": [
      "Compare",
      "Decision",
      "Table"
    ]
  },
  {
    "content": "metrics / series / proportions / limits / daily counts",
    "components": [
      "Stats",
      "Stat",
      "Chart",
      "Sparkline",
      "Series",
      "SegmentedBar",
      "Gauge",
      "CalendarHeatmap"
    ],
    "note": "Trends over time: Chart/Sparkline."
  },
  {
    "content": "events / dates / flows / locations",
    "components": [
      "Timeline",
      "Calendar",
      "Diagram",
      "Map"
    ],
    "note": "Sequences of events: Timeline."
  },
  {
    "content": "code / edits / files / JSON",
    "components": [
      "FileCode",
      "Code",
      "Diff",
      "Tree",
      "Json",
      "KeyValue"
    ]
  },
  {
    "content": "tests / review / logs / timings / coverage / CI",
    "components": [
      "Tests",
      "Findings",
      "Logs",
      "Benchmark",
      "Coverage",
      "Pipeline",
      "StackTrace"
    ],
    "note": "Compiler/test/log output: Findings/Tests/Logs; pasting raw output is wrong."
  },
  {
    "content": "changes / commits / PRs / threads",
    "components": [
      "Changes",
      "Commits",
      "PullRequest",
      "Threads",
      "Environments"
    ]
  },
  {
    "content": "sources / pictures / learning",
    "components": [
      "Sources",
      "Gallery",
      "Hotspots",
      "Walkthrough",
      "Quiz",
      "Flashcards"
    ],
    "note": "Learning checks: Quiz."
  },
  {
    "content": "questions / choices / what-if",
    "components": [
      "Form",
      "Choice",
      "Radio",
      "OptionCards",
      "Slider",
      "Toggle",
      "EditableTable"
    ]
  }
] as const;
const COMPONENT_MAP_TEXT = GUIDANCE_COMPONENT_MAP.map(group => `- ${group.content} → ${group.components.join(", ")}${"note" in group ? `. ${group.note}` : ""}`).join("\n");
export const QUICK_COMPONENTS = ["Stack", "Stats", "Stat", "Table", "Status", "Plan", "Acceptance", "Decision", "Form", "Choice", "Toggle", "Button"] as const;
const QUICK_SIGNATURES = QUICK_COMPONENTS.map(name => examples.find(entry => entry.name === name)!.signature).join("\n");

export const PAGES_GUIDANCE = `# Pages in BB
Replies render in BB, not a terminal. Use an openui-lang fence for fitting structured content, not markdown tables, status/step bullets, pasted output or ASCII diagrams. Skip UI only for a one-line answer or plain conversation. Honor explicit output formats.
For status/readiness with two or more checks, emit one fence with Status + Acceptance; put next actions in Status.next. "No tools" allows a fence: it is not a tool call. Bullets-only is incomplete unless explicitly requested. Status(state, summary?, highlights?, risks?, next?); Acceptance(criteria).
Reply UI needs no file or publish. Publish long HTML/Markdown documents to keep/share. Saved pages default to cards; display: "inline" is for one compact visual. Copy returned ::page directives exactly on their own line; do not announce or restate the page. Reply Forms send answers; saved OpenUI Forms are read-only.
Pick by content:
${COMPONENT_MAP_TEXT}
Inline supplied data. Query("file") is only for existing workspace files, never invented paths or results. Examples below are illustrative. Start with content, not a repeated heading or obligatory Card. Each fence is a complete root = Component(...) program.
Use page_examples when unsure of signatures; page_check when unsure of validity, for complex inputs/data reads or author HTML/CSS. Neither is mandatory for known-valid fences.
HTML: use body.auto and main.page (wide/dashboard only when needed). Use theme classes and --bb-* tokens. Do not restyle base elements, fonts, page width or colours. Use .note, .meta-line, .badge, .scroll and .grid instead of custom rails, eyebrows and layout resets. For art/mockups only, mark each custom <style> or inline-styled element data-pages-style="custom"; this waives only style lint, not sandbox checks.
\`\`\`openui-lang
root = Stack([Status("at-risk", "Release waits on migration", ["API checks pass"], ["Rollback untested"], ["Run rollback rehearsal"]), Acceptance([{criterion: "API checks", status: "pass", evidence: "CI run 812"}, {criterion: "Rollback", status: "unknown", note: "Not run"}])])
\`\`\`
\`\`\`openui-lang
root = Plan([{step: "Add style lint", status: "doing", detail: "Check author CSS before injection"}, {step: "Verify publish warnings", status: "todo", detail: "Keep existing producers working"}])
\`\`\`
\`\`\`openui-lang
root = Decision("Where should jobs run?", [{name: "Postgres", pros: ["Already operated"], cons: ["Shares database capacity"]}, {name: "Redis", pros: ["Separate capacity"], cons: ["Another service"]}], "Postgres", "queue")
\`\`\`
Before sending: fitting components for all structured results? Real data/evidence? Theme intact? Unknown checks still unknown?`;

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
A Button without an action sends its label and Form answers. Only ask when user input is needed. A named Decision sends the choice; omit name for a read-only recommendation. Saved OpenUI forms are read-only.
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
