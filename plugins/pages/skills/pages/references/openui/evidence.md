# Evidence

## Acceptance

`Acceptance(criteria: any[] | Record<string, any> | string, title?: string, columns?: string[])`

Acceptance checks as a list, a condition matrix, an owner/reviewer result, or CSV text. Existing {criterion,status,evidence,note} rows work. Matrices use {name, cells:{condition:result}} and optional columns. A missing result is not tested; done or owner-reported work is only claimed, not independently verified. Click a condition for its evidence, method, reviewer, run, and time. Required gaps and user actions stay visible.

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

Device matrix:

```openui-lang
root = Acceptance([{name:"Upgrade keeps data",cells:{Phone:{status:"pass",by:"QA",evidence:"10,000 records retained"},Desktop:{status:"fail",note:"Filters reset"}}},{name:"Cold start",cells:{Phone:{status:"blocked",needs:"Unlock the test phone"},Desktop:"claimed"}},{name:"Deep links",cells:{Desktop:"pass"}}], "Release checks")
```

CSV checks:

```openui-lang
root = Acceptance("criterion,status,evidence\nBuilds,pass,Build log\nExports CSV,unknown,No run recorded", "Import checks")
```

## Compare

`Compare(options: any[], rows?: {criterion: string, values: (string | number | any)[], better?: "high" | "low"}[] | string, best?: string)`

Compare(options, rows, best?) keeps the scored options table. Compare(images, title?, mode?) compares screenshots: images is [{src,label?,meta?,note?}], reference first. mode is side, wipe, blink, or difference. Blink respects motion preferences and can be paused. Inspect changed pixels and regions, adjust tolerance, and zoom in the shared viewer. Different capture conditions and image sizes are disclosed; this is pixel evidence, not design approval.

Scored:

```openui-lang
root = Compare(["Postgres", "DynamoDB", "SQLite"], [{criterion: "Cost / month", values: ["$120", "$310", "$0"], better: "low"}, {criterion: "p99 read", values: ["4 ms", "9 ms", "1 ms"], better: "low"}, {criterion: "Max size (TB)", values: [64, null, 0.3], better: "high"}, {criterion: "Joins", values: ["Yes", "No", "Yes"]}])
```

Chosen:

```openui-lang
root = Compare(["Plan A", "Plan B"], [{criterion: "Weeks", values: [6, 4], better: "low"}, {criterion: "Risk", values: ["Low", "High"]}], "Plan A")
```

Image difference:

```openui-lang
root = Compare([{"src":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22384%22%20height%3D%22216%22%3E%3Crect%20width%3D%22384%22%20height%3D%22216%22%20fill%3D%22%23f4f4f5%22%2F%3E%3Crect%20x%3D%2224%22%20y%3D%2224%22%20width%3D%22240%22%20height%3D%2216%22%20rx%3D%224%22%20fill%3D%22%2327272a%22%2F%3E%3Crect%20x%3D%2224%22%20y%3D%2260%22%20width%3D%22320%22%20height%3D%228%22%20rx%3D%224%22%20fill%3D%22%23a1a1aa%22%2F%3E%3Crect%20x%3D%2224%22%20y%3D%22134%22%20width%3D%2296%22%20height%3D%2236%22%20rx%3D%226%22%20fill%3D%22%232563eb%22%2F%3E%3Ctext%20x%3D%2245%22%20y%3D%22157%22%20font-family%3D%22sans-serif%22%20font-size%3D%2214%22%20fill%3D%22white%22%3EContinue%3C%2Ftext%3E%3C%2Fsvg%3E","label":"Reference"},{"src":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22384%22%20height%3D%22216%22%3E%3Crect%20width%3D%22384%22%20height%3D%22216%22%20fill%3D%22%23f4f4f5%22%2F%3E%3Crect%20x%3D%2224%22%20y%3D%2224%22%20width%3D%22240%22%20height%3D%2216%22%20rx%3D%224%22%20fill%3D%22%2327272a%22%2F%3E%3Crect%20x%3D%2224%22%20y%3D%2260%22%20width%3D%22320%22%20height%3D%228%22%20rx%3D%224%22%20fill%3D%22%23a1a1aa%22%2F%3E%3Crect%20x%3D%2240%22%20y%3D%22134%22%20width%3D%2296%22%20height%3D%2236%22%20rx%3D%226%22%20fill%3D%22%232563eb%22%2F%3E%3Ctext%20x%3D%2261%22%20y%3D%22157%22%20font-family%3D%22sans-serif%22%20font-size%3D%2214%22%20fill%3D%22white%22%3EContinue%3C%2Ftext%3E%3C%2Fsvg%3E","label":"Candidate"}], "Button position")
```

## Provenance

`Provenance(claim: string | any[], steps?: {step: string, value?: string, source?: string, url?: string, detail?: string}[] | Record<string, any>, value?: string)`

Two evidence chains. Provenance(claim, steps, value?) keeps the existing source-to-number chain. Provenance(stages, expected?, title?) checks which revision or build reached a device or server. Each stage has {name,status,facts?,evidence?,detail?}; expected holds requested branch/sha/build facts. Missing receipts never pass. Expand a stage for full, copyable facts and evidence; identity changes are flagged.

Revenue:

```openui-lang
root = Provenance("Q3 net revenue", [{step: "Exported paid invoices", value: "4,812 rows", source: "Stripe export", url: "https://dashboard.stripe.com/invoices"}, {step: "Summed amounts", value: "$1.31M", source: "billing.invoices"}, {step: "Took out refunds", value: "−$58k", source: "billing.refunds", detail: "Refunds dated inside Q3 only"}], "$1.25M")
```

Installed build:

```openui-lang
root = Provenance([{name:"Checkout",status:"done",facts:{branch:"release",sha:"abc123456789"}},{name:"Build",status:"done",facts:{sha:"abc123456789",build:"204"}},{name:"Install",status:"done",facts:{branch:"main",build:"203",device:"Test phone"}},{name:"Launch"}], {branch:"release",build:"204"}, "Device receipts")
```

## Transcript

`Transcript(lines: any[] | Record<string, any> | string, title?: string, audio?: string)`

Speaker-labelled call notes keep the existing [{speaker,text,time?,highlight?}] view. Transcript(tracks, title?, audio?) compares recognizer outputs: the first track is the reference. Each track has {name,words} or {name,text}; Whisper, Deepgram, AssemblyAI, SRT, and WebVTT work. Shows aligned words, word error rate, speaker errors, a zoomable timeline, and error navigation. audio is an optional scoped file or embedded data URL; no transcription service is called.

Call:

```openui-lang
root = Transcript([{speaker: "Dana", time: 12, text: "Where do we stand on the import bug?"}, {speaker: "Lee", time: 18, text: "Found it. Dates in the old format break the parser."}, {speaker: "Lee", time: 25, text: "Fix is in review, should ship today.", highlight: true}, {speaker: "Dana", time: 71, text: "Great. Let's tell support once it's out."}], "Standup, Oct 16")
```

Recognition comparison:

```openui-lang
root = Transcript([{name:"Reference",words:[{text:"Send",start:0,end:0.4},{text:"the",start:0.4,end:0.6},{text:"invoice",start:0.6,end:1.1},{text:"tomorrow",start:1.1,end:1.8}]},{name:"Recognizer",words:[{text:"Send",start:0,end:0.4},{text:"an",start:0.4,end:0.6},{text:"invoice",start:0.6,end:1.1},{text:"today",start:1.1,end:1.7}]}], "Check recognition errors")
```
