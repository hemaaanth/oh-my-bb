# Manage

## Board

`Board(cards: {title: string, status?: string, owner?: string, tags?: string[], due?: string, detail?: string}[], columns?: string[], name?: string)`

Kanban columns of cards. Each card has a title and a status; cards with the same status share a column. Common statuses ("todo", "in progress", "in review", "blocked", "done") sort in workflow order, others follow as first seen. columns names the columns to show, in order, empty ones too. due is yyyy-mm-dd and shows red once past, unless the card is done. Give name to let the reader move cards (drag, or the ⋯ menu on each card) and send the moves to the thread as "- Card: From → To" lines. Without name it is read-only.

By status:

```openui-lang
root = Board([{title: "Pricing page copy", status: "todo", owner: "Ana", tags: ["web"]}, {title: "Billing webhooks", status: "in progress", owner: "Raj", due: "2026-10-12"}, {title: "Invoice PDF", status: "in review", owner: "Ana"}, {title: "Tax rules", status: "blocked", detail: "Waiting on legal"}, {title: "Stripe keys", status: "done", owner: "Raj"}])
```

Fixed columns:

```openui-lang
root = Board([{title: "Draft post", status: "Writing"}, {title: "Pick images", status: "Writing"}, {title: "Launch email", status: "Scheduled", due: "2026-11-02"}], ["Ideas", "Writing", "Scheduled", "Sent"])
```

Reader moves cards:

```openui-lang
root = Board([{title: "Dark mode", status: "Backlog"}, {title: "CSV export", status: "Backlog", tags: ["data"]}, {title: "SSO", status: "Next"}, {title: "Audit log", status: "Next"}, {title: "Faster search", status: "Now", owner: "Ana"}], ["Backlog", "Next", "Now"], "priorities")
```

## Decision

`Decision(question: string, options: {name: string, pros?: string[], cons?: string[], note?: string}[], recommend?: string, name?: string)`

Options for one decision, each with pros, cons, and a note. recommend is the name of the option you recommend; it is marked. Give name to let the reader choose: each option gets a Choose button that sends "<question>: <option>" to the thread, then locks. Without name it is read-only.

Read-only:

```openui-lang
root = Decision("Which queue?", [{name: "BullMQ", pros: ["Mature", "Redis we already run"], cons: ["Another Redis load"]}, {name: "SQS", pros: ["No servers"], cons: ["AWS lock-in", "Slower local dev"]}, {name: "Postgres queue", note: "pg-boss on the main DB", pros: ["No new service"], cons: ["Load on the main DB"]}], "BullMQ")
```

Reader picks:

```openui-lang
root = Decision("Launch date?", [{name: "Nov 4", pros: ["Before the conference"], cons: ["Tight QA"]}, {name: "Nov 18", pros: ["Full QA week"], cons: ["Misses the conference"]}], "Nov 18", "launch-date")
```

## Estimate

`Estimate(tasks: {task: string, low: number, likely?: number, high: number}[], unit?: string)`

Three-point estimates: per task the best case (low), the likely case, and the worst case (high), with a total. likely defaults to the midpoint. The total also shows P50, P80, and P90 from a PERT model (tasks taken as independent). unit is a short word like "d" (default), "h", "w", or "pts".

Days:

```openui-lang
root = Estimate([{task: "API", low: 2, likely: 3, high: 6}, {task: "UI", low: 3, likely: 4, high: 8}, {task: "Migration", low: 1, high: 4}, {task: "QA", low: 1, likely: 2, high: 3}])
```

Points, one invalid:

```openui-lang
root = Estimate([{task: "Search", low: 3, likely: 5, high: 8}, {task: "Filters", low: 5, likely: 2, high: 8}], "pts")
```

## Plan

`Plan(steps: {step: string, status?: "todo" | "doing" | "done" | "blocked" | "skipped", owner?: string, due?: string, detail?: string}[])`

Ordered steps with an owner and a status each. status "todo" (default), "doing", "done", "blocked", or "skipped". due is yyyy-mm-dd or short text like "Fri". A line on top counts done and blocked steps.

In progress:

```openui-lang
root = Plan([{step: "Freeze the schema", status: "done", owner: "Raj"}, {step: "Backfill old rows", status: "doing", owner: "Ana", due: "2026-10-20", detail: "About 2M rows, in batches"}, {step: "Switch reads", status: "blocked", owner: "Raj", detail: "Needs the backfill"}, {step: "Drop the old table", owner: "Ana", due: "Fri"}, {step: "Load test", status: "skipped"}])
```

## Roadmap

`Roadmap(items: {title: string, start: string, end?: string, lane?: string, status?: "done" | "active" | "planned" | "at-risk" | "blocked", milestone?: boolean}[], today?: string)`

Items on a time axis, grouped by lane. Dates are yyyy-mm-dd; end is the last day. An item with no end, or with milestone true, is a milestone on its start day. status "done", "active", "planned", "at-risk", or "blocked"; without one, an item is active when today is inside it, else planned. The axis reads in days, weeks, or months by span. today defaults to the reader's date.

Weeks, by lane:

```openui-lang
root = Roadmap([{title: "Auth rework", lane: "Platform", start: "2026-10-01", end: "2026-10-24", status: "done"}, {title: "Rate limits", lane: "Platform", start: "2026-10-20", end: "2026-11-14", status: "at-risk"}, {title: "New editor", lane: "Product", start: "2026-10-12", end: "2026-11-28"}, {title: "Beta", lane: "Product", start: "2026-11-30", milestone: true}, {title: "Pricing", lane: "Growth", start: "2026-11-02", end: "2026-11-20", status: "blocked"}], "2026-10-28")
```

Months:

```openui-lang
root = Roadmap([{title: "Research", start: "2026-01-05", end: "2026-02-27", status: "done"}, {title: "Build", start: "2026-03-02", end: "2026-07-31", status: "active"}, {title: "Launch", start: "2026-08-15"}], "2026-05-10")
```

## Status

`Status(state: "on-track" | "at-risk" | "off-track" | "blocked" | "done", summary?: string, highlights?: string[], risks?: string[], next?: string[])`

A status report: the overall state, a one-line summary, then highlights, risks, and next steps as short lists. state "on-track", "at-risk", "off-track", "blocked", or "done". Empty lists are left out.

At risk:

```openui-lang
root = Status("at-risk", "Launch may slip a week.", ["Billing is live in staging", "Docs are done"], ["Tax rules still with legal", "One QA engineer out"], ["Decide the date on Monday", "Start the load test"])
```

On track:

```openui-lang
root = Status("on-track", "All three milestones met.")
```
