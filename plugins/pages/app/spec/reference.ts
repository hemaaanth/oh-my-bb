// The skill reference for spec fences, generated from the catalog during the package build.
// Two layers, so the always-read part stays small as the library grows:
//   references/openui.md            Pages rules, OpenUI syntax, and a one-line index of every component
//   references/openui/<group>.md    exact signatures and examples for one group, read only when used
import { GROUPS, specLibrary } from "./catalog.js";
import { specTools } from "./tools.js";
import { mathFunctions } from "./math.js";

const intro = `# Live UI in a reply (openui-lang)

Write a fenced \`openui-lang\` block in a reply. BB renders it in place, live, while it streams. Text outside the fence stays chat.

Replies render in BB, not a terminal. Use a fitting component instead of markdown tables, numbered status/step lists, pasted output or ASCII diagrams. Skip UI only for a one-line answer or plain conversation without structured information. Honor explicit output formats. Use \`page_publish\` for long documents to keep or share. For a custom HTML/JavaScript app in a reply, read \`references/openui/apps.md\` and use a \`pages-app\` fence.

## Pages rules

- Each fence is a whole program. To change a UI, write a new full fence. Fences do not merge.
- Start with the content. Do not open with a Heading that repeats the reply.
- Choose by content: Status for status; Acceptance/Provenance for checks and receipts; Plan/Steps/Roadmap/Board/Estimate for work; Compare/Decision/Table for options; Stats/Stat/Chart/Series/SegmentedBar/Gauge/CalendarHeatmap for numbers; Timeline/Calendar/Diagram/Map for events and places; FileCode/Code/Diff/Tree/Json/KeyValue for code/data; Tests/Findings/Logs/Benchmark/Coverage/Pipeline/StackTrace for code-work reports; Changes/Commits/PullRequest/Threads/Environments for project state; Sources/Gallery/Hotspots/Walkthrough/Quiz/Flashcards for sources and learning; Form/Choice/Radio/OptionCards/Slider/Toggle/EditableTable for input. Group references have exact arguments.
- Status/readiness with two or more checks needs one fence with Status + Acceptance; next actions go in Status.next. “No tools” does not prohibit a fence: it is not a tool call. Bullets-only is incomplete unless explicitly requested. Pass/fail or before/after checks use Acceptance, not Table; build/run identity uses Provenance; setup with a current step uses Steps; trends use Chart/Sparkline; event sequences use Timeline; phases across lanes/quarters use Roadmap; learning checks use Quiz. Inline supplied data; Query("file") requires an existing workspace file.
- A Button with no action sends its label to the thread, plus its Form's answers as \`- name: value\` lines. Wrap fields in a Form when you need the answers. A sent Form locks, so the reader sends it once.
- Only http(s) links open.
${specTools.length ? "- Query reads data with the tools listed below. Mutation is not available. Otherwise put the data in the program." : "- There are no tools, Query, or Mutation. Put the data in the program."}
- Use \`page_examples\` or \`bb pages examples <component>\` when unsure of signatures/data shapes. Use \`page_check\` or \`bb pages check <file>\` when unsure of validity, for complex inputs/data reads and author HTML/CSS, not before every known-valid fence. Checks are static, not browser or security proofs.
- Keep reports on body.auto/main.page with theme classes and --bb-* tokens. Do not reset base elements, fonts, weight, colours or page widths. Author style conflicts fail checks but only warn at publish. Only art/mockups may waive style lint: put data-pages-style="custom" on each exact style block or inline-styled element, never just an ancestor. Scope selectors to the mockup root. Sandbox checks still apply. Linked CSS and computed cascade are not checked.
- Inherited font-family values and var(--bb-font-sans)/var(--bb-font-mono) are allowed, as are 1px/thin solid var(--bb-rule) left separators. Publish JSON diagnostics are capped at 50 with total/omitted counts.
- App answers are selected for review, not sent automatically. Existing Buttons and Forms keep their direct-send behavior. App frames block fetch and remote resource loads, but self-navigation can still make a network request. Never put secrets in an app.
- The same programs work on a published page: a fence in a Markdown page, or \`<script type="text/openui-lang">\` in an HTML page. Buttons and Forms there are read-only. Query and map answers are saved when you publish, so publish again to refresh them.

Example:

\`\`\`openui-lang
root = Stack([stats, form])
stats = Stats([Stat("Open bugs", 12, "-3", "up"), Stat("Due", "Fri")])
form = Form("next", [Choice("focus", ["Fix bugs", "Ship docs"], "Next focus")], [Button("Send")])
\`\`\`
`;

/** Reference files by path under `skills/pages/references/`. */
export function specReference(): Record<string, string> {
  const toolCalls = specTools.length > 0;
  const prompt = specLibrary.prompt({ inlineMode: true, bindings: true, toolCalls, builtinFunctions: true, ...(toolCalls ? { tools: specTools } : {}) });
  const sections = prompt.split(/\n(?=## )/u);
  // OpenUI's intro, inline mode, and generic rules assume the whole reply is UI. Mutation and filter sections need write tools.
  const kept = sections.filter((section) => /^## (Syntax Rules|Built-in Functions|Query|Action|Available Tools|Hoisting|Final Verification)/u.test(section)).map((section) => {
    if (section.startsWith("## Action")) return `## Action — Button behavior

Buttons without an action send their label and Form answers to the thread.
Use one step directly, or Action([...]) for several steps in order:

- @ToAssistant(message: string, context?: any) — send a message to the assistant.
- @OpenUrl(url: string) — open an HTTP(S) link.
- @Run(queryRef) — refresh a declared read-only Query.
- @Set($variable, value) — update local UI state.
- @Reset($variable) — restore local UI state to its declared default.

Example: Button("Refresh", @Run(data)) where data is a declared Query.
Mutation and write tools are unavailable. Local state changes do not write to files or services.
`;
    return section
      .replace("Use these with Query() for read operations or Mutation() for write operations. The LLM decides which is appropriate based on the tool's purpose.", "Use these read-only tools with Query(). No write tools are available.")
      .replace("Query() and Mutation() calls", "Query() calls")
      .replace("If the user asks for functionality that doesn't match any available tool, use realistic mock data instead of fabricating a tool call.", "If no tool supplies the requested data, explain the missing source. Use illustrative data only when explicitly labelled as an example.")
      .replace(/5\. Every visible filter \$binding appears in at least one Query args object\.\n?/u, "");
  });
  // The lines before the first group explain `?`, ActionExpression, and $binding for every signature.
  const signatureNotes = (sections.find((section) => section.startsWith("## Component Signatures")) ?? "").split(/\n(?=### )/u)[0]!.split("\n").slice(1).join("\n").trim();
  const groups = GROUPS.filter((group) => group.entries.length > 0);
  const index = groups.map((group) => `### ${group.name} (references/openui/${group.id}.md)\n\n${group.entries.map((entry) => `- ${entry.component.name}: ${entry.summary}`).join("\n")}`);
  const files: Record<string, string> = {
    "openui.md": `${intro}\n${kept.join("\n").trim()}\n\n## Math functions\n\n${mathFunctions.map((fn) => `- \`@${fn.name}(${Object.keys(fn.params.shape).join(", ")})\`: ${fn.description}`).join("\n")}\n\n## Components\n\n${signatureNotes}\n\n${index.join("\n\n")}\n`,
  };
  const components = specLibrary.toSpec().components;
  for (const group of groups) {
    const parts = group.entries.map((entry) => {
      const { name } = entry.component;
      const examples = entry.examples.map((example) => `${example.name}:\n\n\`\`\`openui-lang\n${example.code}\n\`\`\``);
      return [`## ${name}`, `\`${components[name]!.signature}\``, entry.component.description, ...examples].join("\n\n");
    });
    files[`openui/${group.id}.md`] = `# ${group.name}\n\n${[...(group.notes ?? []).map((note) => `${note}\n\n`), parts.join("\n\n")].join("")}\n`;
  }
  return files;
}
