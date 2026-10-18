# Evidence

## Acceptance

`Acceptance(criteria: {criterion: string, status?: "pass" | "fail" | "unknown", evidence?: string, note?: string}[], title?: string)`

Acceptance criteria with a result each and the evidence for it. status "pass", "fail", or "unknown" (default). evidence is a link, a file path (shown as code), or short text. The verdict on top says Done only when every criterion passes; unknown is never a pass.

Not proven:

```openui-lang
root = Acceptance([{criterion: "Signup works on mobile", status: "pass", evidence: "https://ci.example.com/runs/812"}, {criterion: "Errors show inline", status: "pass", evidence: "app/signup.test.tsx:44"}, {criterion: "Page loads under 1 s", status: "unknown", note: "No perf run yet"}], "Signup form")
```

Not done:

```openui-lang
root = Acceptance([{criterion: "Exports CSV", status: "pass", evidence: "Tried with 10k rows"}, {criterion: "Keeps filters", status: "fail", evidence: "Filters reset after export"}])
```

Done:

```openui-lang
root = Acceptance([{criterion: "Old links redirect", status: "pass"}, {criterion: "No 404s in logs for a day", status: "pass", evidence: "logs/2026-10-16.txt"}])
```

## Compare

`Compare(options: string[], rows: {criterion: string, values: (string | number | any)[], better?: "high" | "low"}[], best?: string)`

Options side by side across criteria. options are the column names; each row has a criterion and one value per option, in the same order (null for none). Give better "high" or "low" on rows of numbers: the best cell is marked, and the option that wins the most rows is marked as best. Text like "$12" or "120 ms" counts by its leading number. best names the overall pick and overrides that.

Scored:

```openui-lang
root = Compare(["Postgres", "DynamoDB", "SQLite"], [{criterion: "Cost / month", values: ["$120", "$310", "$0"], better: "low"}, {criterion: "p99 read", values: ["4 ms", "9 ms", "1 ms"], better: "low"}, {criterion: "Max size (TB)", values: [64, null, 0.3], better: "high"}, {criterion: "Joins", values: ["Yes", "No", "Yes"]}])
```

Chosen:

```openui-lang
root = Compare(["Plan A", "Plan B"], [{criterion: "Weeks", values: [6, 4], better: "low"}, {criterion: "Risk", values: ["Low", "High"]}], "Plan A")
```

## Provenance

`Provenance(claim: string, steps: {step: string, value?: string, source?: string, url?: string, detail?: string}[], value?: string)`

Where a claim or number came from: the steps from the sources to the claim, in order. Each step says what was done, the value it gave, and its source (a link when url is set). The claim and its value close the chain. Example step: {step: "Summed paid invoices", value: "$1.2M", source: "billing.invoices"}.

Revenue:

```openui-lang
root = Provenance("Q3 net revenue", [{step: "Exported paid invoices", value: "4,812 rows", source: "Stripe export", url: "https://dashboard.stripe.com/invoices"}, {step: "Summed amounts", value: "$1.31M", source: "billing.invoices"}, {step: "Took out refunds", value: "−$58k", source: "billing.refunds", detail: "Refunds dated inside Q3 only"}], "$1.25M")
```

## Transcript

`Transcript(lines: {speaker: string, text: string, time?: string | number, highlight?: boolean}[], title?: string)`

Speaker-labelled lines of a conversation or call. time is seconds from the start (shown as m:ss) or text like "10:42". A name shows once per run of lines from the same speaker. Set highlight on the lines that matter; they get a bar.

Call:

```openui-lang
root = Transcript([{speaker: "Dana", time: 12, text: "Where do we stand on the import bug?"}, {speaker: "Lee", time: 18, text: "Found it. Dates in the old format break the parser."}, {speaker: "Lee", time: 25, text: "Fix is in review, should ship today.", highlight: true}, {speaker: "Dana", time: 71, text: "Great. Let's tell support once it's out."}], "Standup, Oct 16")
```
