# Live UI in a reply (openui-lang)

Write a fenced `openui-lang` block in a reply. BB renders it in place, live, while it streams. Text outside the fence stays chat.

Use it for UI that belongs to this reply: numbers, a table or chart, tabs, code or a diff, a map, a plan, or a choice or form for the user to answer. Use `page_publish` for anything long, anything to keep or share. For a small custom HTML/JavaScript app in a reply, read `references/openui/apps.md` and use a `pages-app` fence.

## Pages rules

- Each fence is a whole program. To change a UI, write a new full fence. Fences do not merge.
- Start with the content. Do not open with a Heading that repeats the reply.
- Find components in the index at the end. Before you use a group, read its file in `references/openui/` for the exact arguments.
- A Button with no action sends its label to the thread, plus its Form's answers as `- name: value` lines. Wrap fields in a Form when you need the answers. A sent Form locks, so the reader sends it once.
- Only http(s) links open.
- Query reads data with the tools listed below. Mutation is not available. Otherwise put the data in the program.
- A fence that does not parse shows as code, so check it before you send.
- Use `page_examples` or `bb pages examples <component>` for signatures and examples. `page_check` and `bb pages check <file>` check programs and app HTML without publishing. Checks are static, not browser or security proofs.
- App answers are selected for review, not sent automatically. Existing Buttons and Forms keep their direct-send behavior. App frames block fetch and remote resource loads, but self-navigation can still make a network request. Never put secrets in an app.
- The same programs work on a published page: a fence in a Markdown page, or `<script type="text/openui-lang">` in an HTML page. Buttons and Forms there are read-only. Query and map answers are saved when you publish, so publish again to refresh them.

Example:

```openui-lang
root = Stack([stats, form])
stats = Stats([Stat("Open bugs", 12, "-3", "up"), Stat("Due", "Fri")])
form = Form("next", [Choice("focus", ["Fix bugs", "Ship docs"], "Next focus")], [Button("Send")])
```

## Syntax Rules

1. Each statement is on its own line: `identifier = Expression`
2. `root` is the entry point — every program must define `root = Stack(...)`
3. Expressions are: strings ("..."), numbers, booleans (true/false), null, arrays ([...]), objects ({...}), or component calls TypeName(arg1, arg2, ...)
4. Use references for readability: define `name = ...` on one line, then use `name` later
5. EVERY variable (except root) MUST be referenced by at least one other variable. Unreferenced variables are silently dropped and will NOT render. Always include defined variables in their parent's children/items array.
6. Arguments are POSITIONAL (order matters, not names). Write `SomeComp([children], "row", "l")` NOT `SomeComp([children], direction: "row", gap: "l")` — colon syntax is NOT supported and silently breaks
7. Optional arguments can be omitted from the end
8. Declare mutable state with `$varName = defaultValue`. Components marked with `$binding` can read/write these. Undeclared $variables are auto-created with null default.
9. String concatenation: `"text" + $var + "more"`
10. Dot member access: `query.field` reads a field; on arrays it extracts that field from every element
11. Index access: `arr[0]`, `data[index]`
12. Arithmetic operators: +, -, *, /, % (work on numbers; + is string concat when either side is a string)
13. Comparison: ==, !=, >, <, >=, <=
14. Logical: &&, ||, ! (prefix)
15. Ternary: `condition ? valueIfTrue : valueIfFalse`
16. Parentheses for grouping: `(a + b) * c`
- Strings use double quotes with backslash escaping

## Built-in Functions

Data functions prefixed with `@` to distinguish from components. These are the ONLY functions available — do NOT invent new ones.
Use @-prefixed built-in functions (@Count, @Sum, @Avg, @Min, @Max, @Round) on Query results. Do NOT hardcode computed values.

@Count(array: any[]) → number — Returns array length
@First(array: any[]) → any — Returns first element of array
@Last(array: any[]) → any — Returns last element of array
@Sum(numbers: number[]) → number — Sum of numeric array
@Avg(numbers: number[]) → number — Average of numeric array
@Min(numbers: number[]) → number — Minimum value in array
@Max(numbers: number[]) → number — Maximum value in array
@Sort(array: any[], field: string, direction?: "asc" | "desc") → any[] — Sort array by field. Direction: "asc" (default) or "desc"
@Filter(array: any[], field: string, operator: "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains", value: any) → any[] — Filter array by field value
@Round(number: number, decimals?: number) → number — Round to N decimal places (default 0)
@Abs(number: number) → number — Absolute value
@Floor(number: number) → number — Round down to nearest integer
@Ceil(number: number) → number — Round up to nearest integer
@Each(array: any[], varName: string, template: any) — Evaluate template for each element. varName is the loop variable — use it ONLY inside the template expression (inline). Do NOT create a separate statement for the template.
@Sin(x: number) — Sine of x radians.
@Cos(x: number) — Cosine of x radians.
@Tan(x: number) — Tangent of x radians.
@Asin(x: number) — Inverse sine, in radians.
@Acos(x: number) — Inverse cosine, in radians.
@Atan(x: number) — Inverse tangent, in radians.
@Atan2(y: number, x: number) — Angle of y/x, in radians, preserving its quadrant.
@Sqrt(x: number) — Square root of a nonnegative number.
@Pow(base: number, exponent: number) — Base raised to exponent.
@Exp(x: number) — e raised to x.
@Log(x: number) — Natural logarithm of a positive number.
@Log10(x: number) — Base-10 logarithm of a positive number.
@Clamp(value: number, min: number, max: number) — Clamp a number to inclusive bounds.
@Lerp(start: number, end: number, t: number) — Linear interpolation; t=0 gives start and t=1 gives end.
@Pi() — The circle constant pi.
@Tau() — One full turn in radians, 2*pi.
@Range(count: number) — Integers 0 through count-1. Count must be an integer from 0 to 2000.
@Random(seed: number) — A deterministic pseudorandom number from 0 to 1 for a numeric seed.

Builtins compose — output of one is input to the next:
`@Count(@Filter(data.rows, "field", "==", "val"))` for KPIs/chart values, `@Round(@Avg(data.rows.score), 1)`, `@Each(data.rows, "item", Comp(item.field))` for per-item rendering.
Array pluck: `data.rows.field` extracts a field from every row → use with @Sum, @Avg, charts, tables.

IMPORTANT @Each rule: The loop variable (e.g. "item") is ONLY available inside the @Each template expression. Always inline the template — do NOT extract it to a separate statement.
CORRECT: `list = @Each(rows, "t", Comp(t.name))`
WRONG: `item = Comp(t.name)` then `list = @Each(rows, "t", item)`, because t is undefined in item.

## Query — Live Data Fetching

Fetch data from available tools. Returns defaults instantly, swaps in real data when it arrives.

```
metrics = Query("tool_name", {arg1: value, arg2: $binding}, {defaultField: 0, defaultData: []}, refreshInterval?)
```

- First arg: tool name (string)
- Second arg: arguments object (may reference $bindings — re-fetches automatically on change)
- Third arg: default data (rendered immediately before fetch resolves)
- Fourth arg (optional): refresh interval in seconds (e.g. 30 for auto-refresh every 30s)
- Use dot access on results: metrics.totalEvents, metrics.data.day (array pluck)
- Query results must use regular identifiers: `metrics = Query(...)`, NOT `$metrics = Query(...)`
- Manual refresh: `Button("Refresh", Action([@Run(query1), @Run(query2)]), "secondary")` — re-fetches the listed queries
- Refresh all queries: create Action with @Run for each query

## Action — Button Behavior

An action wires a button click to operations. Pass one @-prefixed step bare, e.g. Button("Ask", @ToAssistant("Tell me more")). Put several steps in Action([...]), e.g. Button("Read", Action([@OpenUrl("https://example.com"), @ToAssistant("Summarize this page")])). Steps execute in order.
Buttons without an action automatically send their label to the assistant (equivalent to @ToAssistant(label)).

Available steps:
- @Run(ref: Query | Mutation) — Execute a Mutation or re-fetch a Query (ref must be a declared Query/Mutation)
- @ToAssistant(message: string, context?: any) — Send a message to the assistant (for conversational buttons like "Tell me more", "Explain this"). The optional context is any value (object, array, string, number) passed to the assistant as hidden data, e.g. @ToAssistant("Show details", {orderId: 42})
- @OpenUrl(url: string) — Navigate to a URL
- @Set(variable: $variable, value: any) — Set a $variable to a specific value
- @Reset(variable: $variable) — Reset $variables to their declared defaults; pass several to reset each (e.g. @Reset($title, $priority) restores $title="" and $priority="medium")

Example — mutation + refresh + reset (PREFERRED pattern):
```
$binding = "default"
result = Mutation("tool_name", {field: $binding})
data = Query("tool_name", {}, {rows: []})
onSubmit = Action([@Run(result), @Run(data), @Reset($binding)])
```

Example — simple nav:
```
viewBtn = Button("View", @OpenUrl("https://example.com"))
```

- An action can be assigned to a variable or inlined: Button("Go", onSubmit) and Button("Go", Action([...])) both work
- If a @Run(mutation) step fails, remaining steps are skipped (halt on failure)
- @Run(queryRef) re-fetches the query (fire-and-forget, cannot fail)

## Available Tools

Use these with Query() for read operations or Mutation() for write operations. The LLM decides which is appropriate based on the tool's purpose.

- file(path: string) → {path: string, kind: string, rows: object[], data: any, text: string}
  Reads a file from this thread's workspace, its thread storage, or /tmp. A relative path is in the workspace. .json gives data (and rows if it is a list); .csv, .tsv, .jsonl give rows of objects; anything else gives text. At most 2 MB and 5000 rows.
- changes() → {files: {path: string, status: string, additions: number, deletions: number, patch: string}[], additions: number, deletions: number}
  The uncommitted changes in this thread's environment: one row per file with its unified diff (patch is empty when too large). status is added, modified, deleted, renamed, copied, or type_changed.
- commits(limit?: number) → {branch: string, base: string, ahead: number, behind: number, commits: {sha: string, subject: string, author: string, date: string}[]}
  The commits on this thread's branch that are not on its base branch, newest first.
- pull_request() → {pullRequest: any, message: string}
  The pull request of this thread's branch, or pullRequest null with a message. Fields: number, title, url, state, base, head, updatedAt, checks {state, passed, failed, pending, total}, review, mergeable, attention. state is open, draft, merged, or closed; checks.state is passing, failing, pending, or no_checks; review is approved, changes_requested, review_requested, review_required, or none; mergeable is mergeable, conflicts, blocked, or draft.
- threads(limit?: number) → {threads: {id: string, title: string, status: string, updatedAt: string, branch: string, waiting: boolean}[]}
  Recent threads of this project, newest first. status is active, idle, error, pending, starting, or stopping; waiting means it needs an answer.
- environments() → {environments: {id: string, name: string, branch: string, base: string, status: string, updatedAt: string}[]}
  The environments (checkouts and worktrees) of this project. status is ready, creating, provisioning, or error.

### Default values for Query results

Use these shapes as minimal Query defaults:
- file: `{"path":"","kind":"","rows":[],"data":null,"text":""}`
- changes: `{"files":[],"additions":0,"deletions":0}`
- commits: `{"branch":"","base":"","ahead":0,"behind":0,"commits":[]}`
- pull_request: `{"pullRequest":null,"message":""}`
- threads: `{"threads":[]}`
- environments: `{"environments":[]}`

CRITICAL: Use ONLY the tools listed above in Query() and Mutation() calls. Do NOT invent or guess tool names. If the user asks for functionality that doesn't match any available tool, use realistic mock data instead of fabricating a tool call.

## Hoisting & Streaming (CRITICAL)

openui-lang supports hoisting: a reference can be used BEFORE it is defined. The parser resolves all references after the full input is parsed.

During streaming, the output is re-parsed on every chunk. Undefined references are temporarily unresolved and appear once their definitions stream in. This creates a progressive top-down reveal — structure first, then data fills in.

**Recommended statement order for optimal streaming:**
1. `root = Stack(...)` — UI shell appears immediately
2. $variable declarations — state ready for bindings
3. Query statements — defaults resolve immediately so components render with data
4. Component definitions — fill in with data already available
5. Data values — leaf content last

Always write the root = Stack(...) statement first so the UI shell appears immediately, even before child data has streamed in.

## Final Verification
Before finishing, walk your output and verify:
1. root = Stack(...) is the FIRST line (for optimal streaming).
2. Every referenced name is defined. Every defined name (other than root) is reachable from root.
3. Every Query result is referenced by at least one component.
4. Every $binding appears in at least one component or expression.
5. Every visible filter $binding appears in at least one Query args object.

## Math functions

- `@Sin(x)`: Sine of x radians.
- `@Cos(x)`: Cosine of x radians.
- `@Tan(x)`: Tangent of x radians.
- `@Asin(x)`: Inverse sine, in radians.
- `@Acos(x)`: Inverse cosine, in radians.
- `@Atan(x)`: Inverse tangent, in radians.
- `@Atan2(y, x)`: Angle of y/x, in radians, preserving its quadrant.
- `@Sqrt(x)`: Square root of a nonnegative number.
- `@Pow(base, exponent)`: Base raised to exponent.
- `@Exp(x)`: e raised to x.
- `@Log(x)`: Natural logarithm of a positive number.
- `@Log10(x)`: Base-10 logarithm of a positive number.
- `@Clamp(value, min, max)`: Clamp a number to inclusive bounds.
- `@Lerp(start, end, t)`: Linear interpolation; t=0 gives start and t=1 gives end.
- `@Pi()`: The circle constant pi.
- `@Tau()`: One full turn in radians, 2*pi.
- `@Range(count)`: Integers 0 through count-1. Count must be an integer from 0 to 2000.
- `@Random(seed)`: A deterministic pseudorandom number from 0 to 1 for a numeric seed.

## Components

Arguments marked with ? are optional. Sub-components can be inline or referenced; prefer references for better streaming.
Props typed `ActionExpression` accept one @step, or Action([@steps...]) for several. See the Action section for available steps (@Run, @ToAssistant, @OpenUrl, @Set, @Reset).
Props marked `$binding<type>` accept a `$variable` reference for two-way binding.

### Layout (references/openui/layout.md)

- Stack: column or row of parts
- Card: framed group with a title
- Row: equal columns that wrap
- Grid: even grid of tiles
- Carousel: slides that scroll sideways
- Details: collapsible section
- Divider: thin line between parts
- Accordion: sections, one open at a time
- AccordionItem: one section of Accordion
- Modal: button that opens a dialog
- Tabs: switch between views
- Tab: one tab of Tabs

### Content (references/openui/content.md)

- Heading: section title
- Text: paragraph
- Callout: highlighted note
- Stat: one headline number
- Stats: row of Stat
- Badge: status pill
- Tag: topic or category label
- Chips: wrapping row of tags
- Icon: small icon from a fixed set
- Entity: person, place, or thing
- File: file path, optional line
- Image: picture with alt text
- KeyValue: labels and values
- List: bulleted or numbered list
- Sources: numbered cited links
- Source: one link of Sources

### Data (references/openui/data.md)

- Table: rows and columns
- Progress: labelled bar
- Code: highlighted code
- Diff: one file's diff
- Snippet: short text to copy
- FileCode: source lines read from a file
- Gauge: one value on a dial
- SegmentedBar: one bar split into parts
- Sparkline: tiny trend line
- Steps: numbered steps with status
- Timeline: events along a line
- Tree: collapsible tree
- Calendar: month grid with events
- CalendarHeatmap: daily counts as a grid
- Diagram: boxes and arrows

### Charts (references/openui/charts.md)

- Chart: bar, line, area, pie, radar, scatter, funnel, and more
- Series: one series of a Chart

### Inputs (references/openui/inputs.md)

- Input: one-line text field
- TextArea: multi-line text field
- Slider: number slider
- Stepper: number with - and +
- DateInput: date picker
- Rating: stars
- Toggle: on/off switch
- Choice: pick one or several, as pills
- Radio: pick one, with detail
- CheckBoxGroup: tick several, with detail
- Checklist: to-do list to tick off
- Select: dropdown for long lists
- OptionCards: pick one of a few rich options
- Swatches: colour pick
- ListEditor: editable list of strings
- EditableTable: small table to edit
- Button: send or act
- IconButton: icon-only button
- FollowUps: suggested next prompts
- Form: fields sent as one answer

### Media (references/openui/media.md)

- Map: map with numbered places and areas
- Marker: one place on a Map
- Area: shaded region on a Map
- Gallery: picture grid with a full-size viewer
- Photo: one picture of Gallery
- BeforeAfter: pictures side by side to compare
- Hotspots: picture with numbered points
- Hotspot: one point of Hotspots
- ImageSearch: photos found on the web for a query

### 3D & shaders (references/openui/gpu.md)

- Scene: 3D solids, surfaces, models, labels, and materials
- Shader: GLSL, feedback buffers, textures, and live uniforms

### Apps (references/openui/apps.md)

- App: sandboxed HTML, simulations, and custom visuals

### Dev (references/openui/dev.md)

- Benchmark: benchmark comparison
- Coverage: test coverage
- Dependencies: outdated packages and security audits
- Findings: review and lint findings
- Logs: log viewer
- Pipeline: CI run
- StackTrace: stack trace
- Treemap: sizes as tiles
- Waterfall: spans on a timeline

### Project (references/openui/project.md)

- Changes: changed files with diffs
- Commits: commit list
- Json: collapsible JSON
- PullRequest: one pull request
- Tests: test results
- Threads: project threads
- Environments: project environments

### Manage (references/openui/manage.md)

- Board: kanban columns of cards
- Decision: options with pros, cons, a pick
- Estimate: best, likely, worst with a total
- Plan: ordered steps with owners and status
- Roadmap: items on a time axis by lane
- Status: status report

### Evidence (references/openui/evidence.md)

- Acceptance: criteria with pass, fail, or unknown and evidence
- Compare: options side by side, best marked
- Provenance: where a claim or number came from
- Transcript: speaker-labelled lines with times

### Widgets (references/openui/widgets.md)

- Flashcards: study cards to flip
- Quiz: questions with right/wrong and a score
- Timer: countdown or stopwatch
- Walkthrough: step-by-step guide
