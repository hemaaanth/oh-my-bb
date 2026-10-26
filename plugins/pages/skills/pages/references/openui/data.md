# Data

## Table

`Table(columns: string[], rows: (string | number | any)[][], source?: string)`

A data table. Each row is a list of cells in column order. Numbers align right. source is an optional caption or HTTPS URL; otherwise loaded files are credited. An empty source hides the caption.

Mixed cells:

```openui-lang
root = Table(["Task", "Owner", "Days"], [["Copy", "Ana", 2], ["QA", "Raj", 5], ["Launch", "Ana", null]])
```

## Progress

`Progress(label: string, value: number, max?: number)`

A labelled progress bar. max defaults to 100.

Two bars:

```openui-lang
root = Stack([Progress("Done", 3, 5), Progress("Budget used", 72)])
```

## Code

`Code(code: string, language?: string)`

A code block with BB's highlighting. language is a file extension like "ts", "py", "sh", "json".

TypeScript:

```openui-lang
root = Code("export function add(a: number, b: number) {\n  return a + b;\n}", "ts")
```

## Diff

`Diff(patch: string, file: string)`

A unified diff of one file in BB's diff viewer. patch is unified diff text with @@ hunks. file is its path.

One hunk:

```openui-lang
root = Diff("@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }", "src/math.ts")
```

## Snippet

`Snippet(text: string, label?: string)`

A short line of code or text with a Copy button, like a command to run, an ID, or a URL. For longer code with highlighting use Code.

Command:

```openui-lang
root = Snippet("npm install @openuidev/react-lang", "Install")
```

ID:

```openui-lang
root = Snippet("thr_8f2a91c4")
```

## FileCode

`FileCode(file: string, from?: number, to?: number)`

Read source lines from a real file in the thread workspace, thread storage, or /tmp. from and to are one-based inclusive lines; default is the file, at most 400 lines. Shows original line numbers and offers Copy and Open file. Published pages use the source captured at publish time. Unlike Snippet, this reads a file rather than copying supplied text.

Real line numbers:

```openui-lang
root = FileCode("src/math.ts", 2, 4)
```

## Gauge

`Gauge(label: string, value: number, max?: number, tone?: "neutral" | "info" | "success" | "warning" | "danger")`

One value on a half-circle dial from 0 to max (default 100), like a score or a utilisation. tone colours the dial: "info" (default), "success", "warning", "danger", or "neutral".

Score:

```openui-lang
root = Gauge("Lighthouse score", 92, 100, "success")
```

Two dials:

```openui-lang
root = Stack([Gauge("CPU", 71, 100, "warning"), Gauge("Disk GB", 120, 512)], "row")
```

## SegmentedBar

`SegmentedBar(parts: {label: string, value: number, tone?: "neutral" | "info" | "success" | "warning" | "danger"}[], label?: string)`

One bar split into parts by value, with a legend of each part's value and share, like a budget or a disk. Parts without a tone take the chart colours in order.

Budget:

```openui-lang
root = SegmentedBar([{label: "Design", value: 12000}, {label: "Build", value: 30000}, {label: "Launch", value: 8000}], "Budget")
```

Disk with tones:

```openui-lang
root = SegmentedBar([{label: "Used", value: 380, tone: "warning"}, {label: "Free", value: 132, tone: "neutral"}])
```

## Sparkline

`Sparkline(values: number[], tone?: "neutral" | "info" | "success" | "warning" | "danger")`

A tiny line of recent values with no axes, to show a trend at a glance next to text or in a Table cell's place. tone "info" (default), "success", "warning", "danger", or "neutral".

Up:

```openui-lang
root = Sparkline([12, 14, 13, 17, 16, 21, 24], "success")
```

Down:

```openui-lang
root = Sparkline([9, 7, 8, 4, 5, 2], "danger")
```

## Steps

`Steps(items: {title: string, detail?: string, status?: "done" | "current" | "todo" | "blocked"}[])`

Numbered steps in order, joined by a line, like a setup guide or a plan. status "done", "current", "todo" (default), or "blocked".

Setup:

```openui-lang
root = Steps([{title: "Create the project", status: "done"}, {title: "Connect GitHub", detail: "Pick the repositories BB may read.", status: "current"}, {title: "Invite the team"}])
```

Blocked:

```openui-lang
root = Steps([{title: "Build", status: "done"}, {title: "Deploy", detail: "Waiting on a production approval.", status: "blocked"}, {title: "Announce"}])
```

## Timeline

`Timeline(items: {time?: string, title: string, detail?: string, tone?: "neutral" | "info" | "success" | "warning" | "danger"}[])`

Events in order along a line, like a changelog, an incident, or a history. time is free text such as "09:42" or "May 2026". tone colours the dot: "neutral" (default), "info", "success", "warning", or "danger".

Incident:

```openui-lang
root = Timeline([{time: "09:42", title: "Alert fired", detail: "p95 latency over 2 s.", tone: "danger"}, {time: "09:50", title: "Rolled back v2.14", tone: "warning"}, {time: "10:05", title: "Resolved", tone: "success"}])
```

History:

```openui-lang
root = Timeline([{time: "Jan 2026", title: "Beta"}, {time: "May 2026", title: "1.0"}, {time: "Oct 2026", title: "Teams", detail: "Shared projects and roles."}])
```

## Tree

`Tree(items: (string | {label: string, note?: string, children?: any[]})[])`

A collapsible tree. Each item is a path string ("src/app/main.ts"; paths that share folders merge) or {label, note?, children?}, where children is a list of the same kind of items. note is short muted text after the label. Folders start open while the tree stays short.

File paths:

```openui-lang
root = Tree(["src/app/main.ts", "src/app/routes.ts", "src/lib/db.ts", "package.json", "README.md"])
```

Labels and notes:

```openui-lang
root = Tree([{label: "Company", children: [{label: "Engineering", note: "24", children: [{label: "Platform", note: "9"}, {label: "Product", note: "15"}]}, {label: "Design", note: "6"}]}])
```

## Calendar

`Calendar(events: {date: string, title: string, tone?: "neutral" | "info" | "success" | "warning" | "danger"}[], month?: string)`

A month calendar with events. date is "yyyy-mm-dd". month "yyyy-mm" picks the month shown first; it defaults to the first event's month, then today. People step between months and pick a day to see its events. tone colours an event: "info" (default), "success", "warning", "danger", or "neutral".

Launch month:

```openui-lang
root = Calendar([{date: "2026-11-03", title: "Design review"}, {date: "2026-11-12", title: "Code freeze", tone: "warning"}, {date: "2026-11-12", title: "QA starts"}, {date: "2026-11-19", title: "Launch", tone: "success"}], "2026-11")
```

## CalendarHeatmap

`CalendarHeatmap(days: {date: string, value: number}[], label?: string, tone?: "neutral" | "info" | "success" | "warning" | "danger")`

Daily counts as a GitHub-style grid of weeks, from the first date to the last. date is "yyyy-mm-dd"; missing days count as 0 and repeated dates add up. label names what is counted, like "Commits". tone colours the cells: "success" (default), "info", "warning", "danger", or "neutral".

Commits:

```openui-lang
root = CalendarHeatmap([{date: "2026-09-01", value: 3}, {date: "2026-09-02", value: 5}, {date: "2026-09-04", value: 1}, {date: "2026-09-08", value: 8}, {date: "2026-09-09", value: 2}, {date: "2026-09-10", value: 6}, {date: "2026-09-15", value: 4}, {date: "2026-09-17", value: 9}, {date: "2026-09-18", value: 3}, {date: "2026-09-22", value: 2}, {date: "2026-09-24", value: 7}, {date: "2026-09-29", value: 5}, {date: "2026-10-01", value: 1}, {date: "2026-10-06", value: 6}, {date: "2026-10-08", value: 4}, {date: "2026-10-13", value: 10}], "Commits")
```

## Diagram

`Diagram(nodes: {id: string, label?: string, tone?: "neutral" | "info" | "success" | "warning" | "danger"}[], edges: {from: string, to: string, label?: string}[], direction?: "down" | "right")`

A flow diagram of boxes and arrows, laid out in layers. Each node has an id and an optional label (defaults to the id). Each edge goes from one node id to another, with an optional short label. direction "down" (default) or "right". tone outlines a node: "info", "success", "warning", "danger", or "neutral" (default). Keep it under about 15 nodes.

Flow:

```openui-lang
root = Diagram([{id: "req", label: "Request"}, {id: "auth", label: "Auth"}, {id: "cache", label: "Cache"}, {id: "db", label: "Database"}, {id: "res", label: "Response", tone: "success"}], [{from: "req", to: "auth"}, {from: "auth", to: "cache"}, {from: "cache", to: "res", label: "hit"}, {from: "cache", to: "db", label: "miss"}, {from: "db", to: "res"}])
```

Left to right with a loop:

```openui-lang
root = Diagram([{id: "draft", label: "Draft"}, {id: "review", label: "Review", tone: "info"}, {id: "ship", label: "Ship", tone: "success"}], [{from: "draft", to: "review"}, {from: "review", to: "draft", label: "changes"}, {from: "review", to: "ship"}], "right")
```
