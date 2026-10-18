# Inputs

Every field takes its name first. Inside a Form, a Button sends each field as a "- name: value" line; lists are joined with commas.

Bind a field's value to a $variable to read it elsewhere live; a bound or preset value inside a Form is sent too.

Choice for a few short options, Radio or CheckBoxGroup when options need detail, Select for long lists, OptionCards for a few rich options.

## Input

`Input(name: string, label?: string, placeholder?: string, value?: $binding<string>)`

A one-line text field. Bind value to a $variable to use it elsewhere.

With label:

```openui-lang
root = Input("title", "Title", "Name the release")
```

Bound:

```openui-lang
$name = "Ada"
root = Stack([Input("name", "Name", null, $name), Text("Hello, " + $name, "muted")])
```

## TextArea

`TextArea(name: string, label?: string, placeholder?: string, value?: $binding<string>)`

A text field for a few lines or more. The reader can drag it taller.

Notes:

```openui-lang
root = TextArea("notes", "Anything else?", "Context, constraints, links")
```

Preset:

```openui-lang
root = TextArea("summary", "Summary", null, "Ship the beta to 5% of users on Monday.\nRoll back if errors pass 1%.")
```

## Slider

`Slider(name: string, min: number, max: number, step?: number, label?: string, value?: $binding<number>)`

A number slider. Bind value to a $variable to drive other components live.

Drives a Text:

```openui-lang
$budget = 40
root = Stack([Slider("budget", 0, 100, 5, "Budget", $budget), Text("Budget: " + $budget + "%", "muted")])
```

## Stepper

`Stepper(name: string, label?: string, min?: number, max?: number, step?: number, value?: $binding<number>)`

A whole or decimal number with - and + buttons, for counts and small amounts. step defaults to 1; it starts at value, else min, else 0. Arrow keys step, Page Up/Down step by 10.

Count:

```openui-lang
root = Stepper("seats", "Seats", 1, 20, 1, 3)
```

Decimals, bound:

```openui-lang
$ratio = 1.5
root = Stack([Stepper("ratio", "Ratio", 0, 3, 0.25, $ratio), Text("Ratio " + $ratio, "muted")])
```

No bounds:

```openui-lang
root = Stepper("offset", "Offset")
```

## DateInput

`DateInput(name: string, label?: string, min?: string, max?: string, value?: $binding<string>)`

A date picker. value, min, and max are yyyy-mm-dd dates, and the answer is sent the same way.

Range:

```openui-lang
root = DateInput("launch", "Launch date", "2026-11-01", "2026-12-31", "2026-11-18")
```

Empty:

```openui-lang
root = DateInput("due", "Due")
```

## Rating

`Rating(name: string, label?: string, max?: number, value?: $binding<number>)`

Stars from 1 to max (default 5, at most 10). 0 means not rated yet. Picking the current star again clears it.

Rated:

```openui-lang
root = Rating("quality", "How good was the answer?", 5, 4)
```

Ten, unrated:

```openui-lang
root = Rating("likely", "How likely are you to recommend us?", 10)
```

## Toggle

`Toggle(name: string, label: string, value?: $binding<boolean>)`

An on/off switch.

Toggle:

```openui-lang
root = Toggle("notify", "Notify me")
```

## Choice

`Choice(name: string, options: (string | {label: string, value?: string, detail?: string})[], label?: string, multiple?: boolean, value?: $binding<string | string[]>)`

Pick one option, or several with multiple true. Shown as pills, so keep options short; options are strings or {label, value?, detail?}; value defaults to label and is what is sent. For options that need a line of detail use Radio or CheckBoxGroup; for a long list use Select.

One:

```openui-lang
root = Choice("channel", ["Email", "Ads", "Social"], "Channel")
```

Several:

```openui-lang
root = Choice("days", ["Mon", "Tue", "Wed", "Thu", "Fri"], "Days", true, ["Mon", "Wed"])
```

## Radio

`Radio(name: string, options: (string | {label: string, value?: string, detail?: string})[], label?: string, value?: $binding<string>)`

Pick exactly one option from a short column of radio buttons; options are strings or {label, value?, detail?}; value defaults to label and is what is sent, and detail shows under the option. Arrow keys move the pick.

With detail:

```openui-lang
root = Radio("plan", [{label: "Starter", detail: "One project, community support"}, {label: "Team", detail: "Ten projects, email support"}, {label: "Business", value: "biz", detail: "Unlimited, SSO, a named contact"}], "Plan", "Team")
```

Plain:

```openui-lang
root = Radio("size", ["Small", "Medium", "Large"], "Size")
```

## CheckBoxGroup

`CheckBoxGroup(name: string, options: (string | {label: string, value?: string, detail?: string})[], label?: string, value?: $binding<string[]>)`

Tick any number of options in a column of checkboxes; options are strings or {label, value?, detail?}; value defaults to label and is what is sent. The ticked values are sent in option order.

With detail:

```openui-lang
root = CheckBoxGroup("checks", [{label: "Unit tests", detail: "vitest, about 40s"}, {label: "Type check"}, {label: "End-to-end", detail: "Playwright, about 6 min"}], "Run before merge", ["Unit tests", "Type check"])
```

## Checklist

`Checklist(name: string, items: (string | {label: string, value?: string, detail?: string})[], label?: string, value?: $binding<string[]>)`

A to-do list the reader ticks off, with an "n of m done" count. items are strings or {label, value?, detail?}; value lists the items already done. Done items are sent.

Launch:

```openui-lang
root = Checklist("launch", ["Freeze the branch", "Run the migration", {label: "Flip the flag", detail: "billing.v2 to 100%"}, "Post in #releases"], "Launch steps", ["Freeze the branch"])
```

Empty:

```openui-lang
root = Checklist("todo", [], "Nothing to do")
```

## Select

`Select(name: string, options: (string | {label: string, value?: string, detail?: string})[], label?: string, placeholder?: string, value?: $binding<string>)`

Pick one option from a dropdown, good for long lists; options are strings or {label, value?, detail?}; value defaults to label and is what is sent. placeholder shows until a pick, default "Choose…".

Region:

```openui-lang
root = Select("region", ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1", "ap-northeast-1"], "Region", "Pick a region")
```

Labels and preset:

```openui-lang
root = Select("tz", [{label: "London", value: "Europe/London"}, {label: "New York", value: "America/New_York"}, {label: "Tokyo", value: "Asia/Tokyo", detail: "UTC+9"}], "Time zone", null, "America/New_York")
```

## OptionCards

`OptionCards(name: string, options: (string | {label: string, value?: string, detail?: string, icon?: string})[], label?: string, multiple?: boolean, value?: $binding<string | string[]>)`

Pick one of a few rich options shown as cards side by side, or several with multiple true. options are {label, value?, detail?, icon?}; value defaults to label. icon is one of: arrowdown, arrowleft, arrowright, arrowup, bell, bookmark, bug, calendar, check, chevrondown, chevronleft, chevronright, chevronup, help, clock, code, copy, download, more, external, eye, file, filter, folder, branch, heart, home, info, idea, link, lock, mail, minus, pause, edit, play, plus, refresh, rocket, search, send, settings, share, sparkles, star, thumbsdown, thumbsup, trash, warning, upload, user, close, zap.

One:

```openui-lang
root = OptionCards("approach", [{label: "Patch", icon: "zap", detail: "Fix the query in place. Fast, keeps the debt."}, {label: "Refactor", icon: "code", detail: "Move reads to the cache layer. Two days."}, {label: "Rewrite", icon: "rocket", detail: "New service. A sprint, cleanest result."}], "How should we fix it?", false, "Refactor")
```

Several:

```openui-lang
root = OptionCards("extras", [{label: "Dark mode"}, {label: "Export to CSV", detail: "From any table"}, {label: "Slack alerts", icon: "bell"}], "Add to the next release", true)
```

## Swatches

`Swatches(name: string, colors: (string | {value: string, name?: string})[], label?: string, value?: $binding<string>)`

Pick one colour from a row of chips. colors are CSS colours ("#2563eb", "oklch(0.7 0.1 200)") or {value, name?}; the chosen value is sent.

Named:

```openui-lang
root = Swatches("accent", [{value: "#2563eb", name: "Blue"}, {value: "#16a34a", name: "Green"}, {value: "#d97706", name: "Amber"}, {value: "#dc2626", name: "Red"}, {value: "#7c3aed", name: "Violet"}], "Accent colour", "#16a34a")
```

Plain CSS:

```openui-lang
root = Swatches("bg", ["white", "oklch(0.95 0.02 90)", "#0f172a"], "Background")
```

## ListEditor

`ListEditor(name: string, label?: string, placeholder?: string, value?: $binding<string[]>)`

A list the reader grows, edits in place, and trims, such as names or tags. value is the starting list. Repeats are refused.

Tags:

```openui-lang
root = ListEditor("tags", "Tags", "Add a tag", ["billing", "urgent"])
```

Empty:

```openui-lang
root = ListEditor("reviewers", "Reviewers", "Name or handle")
```

## EditableTable

`EditableTable(name: string, columns: (string | {key: string, label?: string, type?: "text" | "number" | "boolean"})[], label?: string, rows?: Record<string, any>[])`

A small table the reader edits: change cells, add rows, remove rows. columns are keys or {key, label?, type?}; type "text", "number", or "boolean" (a checkbox), else the kind of the first filled cell. rows are the starting rows. The rows are sent as JSON.

Typed columns:

```openui-lang
root = EditableTable("order", [{key: "item"}, {key: "qty", label: "Qty", type: "number"}, {key: "gift", label: "Gift wrap", type: "boolean"}], "Order", [{item: "Tea", qty: 2, gift: false}, {item: "Mug", qty: 1, gift: true}])
```

Empty:

```openui-lang
root = EditableTable("guests", ["name", "email"], "Guests")
```

## Button

`Button(label: string, action?: ActionExpression, variant?: "primary" | "secondary")`

A button. With no action it sends its label (and its Form answers) to the assistant, then locks. variant "primary" (default) or "secondary".

Variants:

```openui-lang
root = Stack([Button("Ship it"), Button("Not yet", null, "secondary")], "row", "s")
```

## IconButton

`IconButton(label: string, icon: string, action?: ActionExpression, variant?: "primary" | "secondary" | "ghost")`

A square button that shows only an icon; label is its tooltip and screen reader name, and is what it sends, like Button. variant "secondary" (default, hairline frame), "primary" (solid), or "ghost" (no frame). icon is one of: arrowdown, arrowleft, arrowright, arrowup, bell, bookmark, bug, calendar, check, chevrondown, chevronleft, chevronright, chevronup, help, clock, code, copy, download, more, external, eye, file, filter, folder, branch, heart, home, info, idea, link, lock, mail, minus, pause, edit, play, plus, refresh, rocket, search, send, settings, share, sparkles, star, thumbsdown, thumbsup, trash, warning, upload, user, close, zap. An unknown icon shows the label instead.

Variants:

```openui-lang
root = Stack([IconButton("Like", "thumbs-up", null, "primary"), IconButton("Retry", "refresh"), IconButton("More", "more", null, "ghost"), IconButton("Unknown icon", "kraken")], "row", "s")
```

## FollowUps

`FollowUps(prompts: string[], label?: string)`

Suggested next questions, at the end of a reply. Each prompt is a row the reader clicks to send its text to the thread as their next message. Keep 2 to 4 short prompts. label is a heading above them.

Prompts:

```openui-lang
root = FollowUps(["Show the slowest queries", "Compare with last week", "Draft the incident note"], "Next")
```

## Form

`Form(name: string, fields: any[], buttons: (Button | IconButton)[])`

Groups fields so a Button sends all their answers to the assistant in one message. A sent Form locks until the reader picks Edit answers.

Form:

```openui-lang
root = Form("launch", [Choice("channel", ["Email", "Ads"], "Channel"), Slider("budget", 0, 100, 5, "Budget"), Input("note", "Note")], [Button("Approve"), Button("Hold", null, "secondary")])
```

Many fields:

```openui-lang
root = Form("intake", [Radio("kind", ["Bug", "Feature", "Question"], "Kind"), DateInput("due", "Needed by"), Stepper("people", "People affected", 1, 1000), Rating("pain", "How painful?"), CheckBoxGroup("areas", ["API", "Web", "Mobile"], "Areas"), TextArea("details", "Details")], [Button("Send"), IconButton("Discard", "trash", null, "ghost")])
```
