// The skill reference for spec fences, generated from the catalog during the package build.
// Two layers, so the always-read part stays small as the library grows:
//   references/openui.md            Pages rules, OpenUI syntax, and a one-line index of every component
//   references/openui/<group>.md    exact signatures and examples for one group, read only when used
import { GROUPS, specLibrary } from "./catalog.js";
import { specTools } from "./tools.js";
import { mathFunctions } from "./math.js";

const intro = `# Live UI in a reply (openui-lang)

Write a fenced \`openui-lang\` block in a reply. BB renders it in place, live, while it streams. Text outside the fence stays chat.

Use it for UI that belongs to this reply: numbers, a table or chart, tabs, code or a diff, a map, a plan, or a choice or form for the user to answer. Use \`page_publish\` for anything long, anything to keep or share. For a small custom HTML/JavaScript app in a reply, read \`references/openui/apps.md\` and use a \`pages-app\` fence.

## Pages rules

- Each fence is a whole program. To change a UI, write a new full fence. Fences do not merge.
- Start with the content. Do not open with a Heading that repeats the reply.
- Choose a component from the task: Stats for metrics, Timeline for history, Diff for edits, Compare/Decision for options, Diagram for systems, Plan for steps, Acceptance for verification. Call \`page_examples\` with those names for exact arguments. Group files in \`references/openui/\` have more detail.
- A Button with no action sends its label to the thread, plus its Form's answers as \`- name: value\` lines. Wrap fields in a Form when you need the answers. A sent Form locks, so the reader sends it once.
- Only http(s) links open.
${specTools.length ? "- Query reads data with the tools listed below. Mutation is not available. Otherwise put the data in the program." : "- There are no tools, Query, or Mutation. Put the data in the program."}
- A fence that does not parse shows as code, so check it before you send.
- Use \`page_examples\` or \`bb pages examples <component>\` for signatures and examples. \`page_check\` and \`bb pages check <file>\` check programs and app HTML without publishing. Checks are static, not browser or security proofs.
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
