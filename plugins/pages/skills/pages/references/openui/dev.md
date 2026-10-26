# Dev

Most Dev components read the report a tool writes. Load it with Query("file", {path: "coverage/coverage-summary.json"}, {data: null}) and pass data.data (JSON) or data.text (logs, traces, XML).

## Benchmark

`Benchmark(results: any[] | Record<string, any>, title?: string, unit?: string)`

Benchmark results from manual before/after rows, hyperfine JSON, vitest bench JSON, or runs with metrics and conditions. unit accepts time, bytes, rates, percentages, or a label. Changes smaller than noise stay unchanged. Different recorded conditions are not presented as a like-for-like improvement. Expand a result for samples and conditions.

Before and after:

```openui-lang
root = Benchmark([{name: "parse 1 MB", before: 18.4, after: 11.2, unit: "ms"}, {name: "render cart", before: 3.1, after: 3.12, unit: "ms"}, {name: "checkout", before: 42, after: 51, unit: "ms", noise: 2}, {name: "bundle", before: 349438, after: 331200, unit: "B"}], "This branch vs main")
```

hyperfine:

```openui-lang
root = Benchmark({"results":[{"command":"esbuild","mean":0.312,"stddev":0.01},{"command":"rollup","mean":4.84,"stddev":0.2},{"command":"webpack","mean":9.71,"stddev":0.35}]}, "Bundlers")
```

Measurement conditions:

```openui-lang
root = Benchmark([{name:"Build",before:{value:120,context:{device:"Laptop",thermal:"Nominal"}},after:{value:80,context:{device:"Desktop",thermal:"Nominal"}},unit:"ms"},{name:"Parse",before:[18.2,18.5,18.3],after:[11.1,11.3,11.2],unit:"ms"}], "Comparable results")
```

All experiment runs:

```openui-lang
root = Benchmark({runs:[{name:"Laptop, cold",status:"ok",metrics:{latency:120,memory:24000},context:{device:"Laptop",cache:"Cold"}},{name:"Laptop, warm",status:"ok",metrics:{latency:80,memory:26000},context:{device:"Laptop",cache:"Warm"}},{name:"Desktop",status:"failed",context:{device:"Desktop"},note:"Process crashed before measuring"}],metrics:{latency:{unit:"ms",better:"lower"},memory:{unit:"B",better:"lower"}}}, "Experiment notebook")
```

## Coverage

`Coverage(report: any[] | Record<string, any> | string, title?: string, metric?: "lines" | "statements" | "functions" | "branches")`

Coverage from Istanbul coverage-summary.json, lcov.info text, coverage.py JSON, Go coverage.out text, or existing manual rows [{path, covered, total} | {path, pct}]. Files can be filtered, read as a directory tree, and expanded to inspect uncovered ranges. Query("file") returns .data for JSON and .text for lcov/Go. metric selects lines, statements, functions, or branches.

From a file:

```openui-lang
data = Query("file", {path: "coverage/coverage-summary.json"}, {data: null})
root = Coverage(data.data, "Coverage")
```

Inline, branches:

```openui-lang
root = Coverage({"total":{"lines":{"total":1240,"covered":1017,"pct":82.02},"statements":{"total":1302,"covered":1046,"pct":80.34},"functions":{"total":210,"covered":151,"pct":71.9},"branches":{"total":388,"covered":251,"pct":64.69}},"/w/shop/src/cart/total.ts":{"lines":{"total":48,"covered":48,"pct":100}},"/w/shop/src/cart/coupons.ts":{"lines":{"total":120,"covered":70,"pct":58.33}},"/w/shop/src/checkout/pay.ts":{"lines":{"total":310,"covered":229,"pct":73.87}},"/w/shop/src/checkout/address.ts":{"lines":{"total":95,"covered":94,"pct":98.94}}}, null, "branches")
```

LCOV uncovered lines:

```openui-lang
root = Coverage("SF:src/cart.ts\nDA:10,4\nDA:11,0\nDA:12,0\nDA:13,2\nLF:4\nLH:2\nend_of_record\n", "Cart coverage")
```

Python coverage:

```openui-lang
root = Coverage({meta:{version:"7.6"},files:{"worker.py":{executed_lines:[1,2,5],missing_lines:[3,4],summary:{covered_lines:3,num_statements:5,percent_covered:60}}},totals:{covered_lines:3,num_statements:5,percent_covered:60}}, "Worker coverage")
```

Go coverage:

```openui-lang
root = Coverage("mode: set\nexample.com/shop/cart.go:10.1,12.2 2 1\nexample.com/shop/cart.go:14.1,18.2 3 0\n", "Go statements")
```

## Dependencies

`Dependencies(packages: any[] | Record<string, any>, title?: string)`

Outdated and vulnerable dependencies. packages accepts existing manual rows, npm/pnpm outdated JSON, pip outdated JSON, npm audit v2, pnpm advisories, or {outdated, audit}. Expand a vulnerability for affected versions, direct/transitive relationships, advisory links, and the reported fix. This component never installs or updates a package.

npm outdated:

```openui-lang
root = Dependencies({"react":{"current":"19.0.2","wanted":"19.0.2","latest":"20.1.0","type":"dependencies"},"zod":{"current":"4.0.5","wanted":"4.1.3","latest":"4.1.3","type":"dependencies"},"vitest":{"current":"3.2.1","wanted":"3.2.4","latest":"3.2.4","type":"devDependencies"},"typescript":{"current":"5.9.2","wanted":"5.9.3","latest":"6.0.1","type":"devDependencies"}}, "Outdated")
```

From a file:

```openui-lang
data = Query("file", {path: "outdated.json"}, {data: null})
root = Dependencies(data.data)
```

npm audit:

```openui-lang
root = Dependencies({auditReportVersion:2,vulnerabilities:{axios:{name:"axios",severity:"high",isDirect:true,via:[{name:"axios",title:"Untrusted redirect",url:"https://github.com/axios/axios/security/advisories",severity:"high",range:"<1.8.2"}],effects:[],range:"<1.8.2",nodes:["node_modules/axios"],fixAvailable:{name:"axios",version:"1.8.2",isSemVerMajor:false}}},metadata:{dependencies:{total:311}}}, "Security audit")
```

## Findings

`Findings(findings: any[] | Record<string, any> | string, title?: string)`

Review, lint, or security findings from manual rows, ESLint/Ruff/oxlint/Biome JSON, SARIF, tsc text, or a structured review. Search by message, path, rule, or status. Expand a finding for evidence, source files, suggested patches, and ownership or verification details. Fixed by an owner is distinct from confirmed by a reviewer.

Review:

```openui-lang
root = Findings([{severity: "high", title: "SQL built from user input", file: "src/orders/query.ts", line: 31, rule: "sql-injection", detail: "Pass the id as a parameter.", code: "db.query(`SELECT * FROM orders WHERE id = ${req.params.id}`)"}, {severity: "medium", title: "Promise is not awaited", file: "src/checkout/pay.ts", line: 58}, {severity: "low", title: "Unused import", file: "src/checkout/pay.ts", line: 2, rule: "no-unused-vars"}], "Review")
```

SARIF:

```openui-lang
root = Findings({"runs":[{"results":[{"ruleId":"js/xss","level":"error","message":{"text":"Unescaped HTML from a query string."},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/search.tsx"},"region":{"startLine":22}}}]},{"ruleId":"js/unused-local","level":"note","message":{"text":"Unused variable 'tmp'."},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/util.ts"},"region":{"startLine":4}}}]}]}]})
```

Compiler output:

```openui-lang
root = Findings("src/cart.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.", "Type check")
```

Review lifecycle:

```openui-lang
root = Findings([{id:"auth",severity:"high",title:"Check the session before changing roles",area:"auth",file:"src/roles.ts",line:18,status:"open",fix:"Verify the session and required role before updating."},{id:"cache",severity:"medium",title:"Cache eviction",status:"fixed",fixNote:"Patch is applied; load check is still missing."},{id:"import",severity:"low",title:"Unused import",status:"confirmed",by:"Reviewer",revision:"abc123"}], "Follow-up review")
```

## Logs

`Logs(log: string | any[], title?: string, wrap?: boolean)`

A log viewer: levels toned, repeated lines folded with a count, links clickable, and filters for errors and warnings. log is the text (ANSI colours are removed) or a list of lines or {level, msg, time} entries (pino and bunyan JSON lines work). Levels are read from words like ERROR, [warn], level=info. wrap true wraps long lines. Load a file with Query("file") and pass its text.

Server log:

```openui-lang
root = Logs("2026-06-15T09:00:01Z INFO  server listening on http://localhost:3000\n2026-06-15T09:00:04Z DEBUG cache warm: 312 keys\n2026-06-15T09:01:10Z WARN  slow query (812 ms): SELECT * FROM orders\n2026-06-15T09:01:12Z INFO  GET /api/cart 200 14ms\n2026-06-15T09:01:12Z INFO  GET /api/cart 200 14ms\n2026-06-15T09:01:12Z INFO  GET /api/cart 200 14ms\n2026-06-15T09:01:15Z ERROR payment failed: card_declined\n    at charge (src/checkout/pay.ts:42:11)\n2026-06-15T09:01:15Z INFO  see https://docs.example.com/errors/card_declined", "server.log")
```

From a file:

```openui-lang
data = Query("file", {path: "/tmp/build.log"}, {text: ""})
root = Logs(data.text, data.path, true)
```

JSON lines:

```openui-lang
root = Logs([{level: 30, time: "09:00:01", msg: "worker started"}, {level: 40, time: "09:00:05", msg: "queue is 80% full"}, {level: 50, time: "09:00:07", msg: "job 812 failed"}])
```

## Pipeline

`Pipeline(jobs: any[] | Record<string, any>, title?: string)`

A CI run: its overall status, then jobs by stage, failures first; a job with steps opens to show them (failed jobs start open). jobs is [{name, status, ms?, stage?, url?, steps?}] or `gh run view --json jobs` output (status and conclusion, startedAt and completedAt). status is success, failure, in_progress, queued, cancelled, or skipped; words like passed, running, pending, error also work.

Stages:

```openui-lang
root = Pipeline([{name: "lint", stage: "check", status: "success", ms: 21000}, {name: "typecheck", stage: "check", status: "success", ms: 48000}, {name: "unit (node 22)", stage: "test", status: "failure", ms: 95000, steps: [{name: "install", status: "success", ms: 30000}, {name: "vitest", status: "failure", ms: 64000}, {name: "upload", status: "skipped"}]}, {name: "unit (node 24)", stage: "test", status: "success", ms: 91000}, {name: "deploy", stage: "release", status: "skipped"}], "CI #812")
```

gh run view:

```openui-lang
root = Pipeline({"jobs":[{"name":"build","status":"completed","conclusion":"success","startedAt":"2026-06-15T09:00:00Z","completedAt":"2026-06-15T09:02:14Z","steps":[{"name":"Checkout","status":"completed","conclusion":"success"},{"name":"Build","status":"completed","conclusion":"success"}]},{"name":"e2e","status":"in_progress","startedAt":"2026-06-15T09:02:20Z"}]})
```

## StackTrace

`StackTrace(trace: string | Record<string, any>, title?: string)`

An error and its stack, your code first: runs of library frames (node_modules, node:, site-packages, java.*) fold into one row; causes follow. trace is the text of a JavaScript, Python, or Java/Kotlin trace, or {name, message, stack}. Python traces show the innermost frame first like the others.

JavaScript:

```openui-lang
root = StackTrace("TypeError: Cannot read properties of undefined (reading 'price')\n    at lineTotal (/w/shop/src/cart/total.ts:12:24)\n    at Array.map (<anonymous>)\n    at total (/w/shop/src/cart/total.ts:5:22)\n    at renderWithHooks (/w/shop/node_modules/react-dom/cjs/react-dom.development.js:15486:18)\n    at mountIndeterminateComponent (/w/shop/node_modules/react-dom/cjs/react-dom.development.js:20103:13)\n    at beginWork (/w/shop/node_modules/react-dom/cjs/react-dom.development.js:21626:16)\n    at Cart (/w/shop/src/cart/Cart.tsx:31:9)\n  [cause]: Error: item 3 has no product\n    at loadItems (/w/shop/src/cart/load.ts:20:11)")
```

Python:

```openui-lang
root = StackTrace("Traceback (most recent call last):\n  File \"/app/main.py\", line 14, in <module>\n    main()\n  File \"/app/main.py\", line 10, in main\n    total = order_total(items)\n  File \"/app/orders.py\", line 7, in order_total\n    return sum(item[\"price\"] for item in items)\nKeyError: 'price'", "Worker crash")
```

## Treemap

`Treemap(items: any[] | Record<string, any>, title?: string, unit?: string)`

Sizes as nested tiles, area by value: bundle or folder sizes, time by area, cost by service. items is [{name, value, group?}] (path and size also work) or {name: size}. Items that share a group sit together under its name. The largest 24 show; the rest fold into one "N more" tile. unit (B, KB, ms, $, …) formats values.

Bundle:

```openui-lang
root = Treemap([{name: "react-dom", value: 131000, group: "vendor"}, {name: "zod", value: 58000, group: "vendor"}, {name: "date-fns", value: 31000, group: "vendor"}, {name: "checkout", value: 72000, group: "app"}, {name: "cart", value: 41000, group: "app"}, {name: "search", value: 26000, group: "app"}, {name: "app.css", value: 18000, group: "styles"}], "dist/ by chunk", "B")
```

Flat:

```openui-lang
root = Treemap({compute: 4210, storage: 1380, network: 920, logs: 410, backups: 160}, "Cloud cost", "$")
```

## Waterfall

`Waterfall(spans: any[] | Record<string, any>, title?: string, unit?: string)`

Spans on one time axis: trace spans, build steps, page requests. spans is [{name, start, duration, depth?, failed?, detail?}] (end works for duration; status failure marks it failed), a HAR file (browser devtools export), or Chrome trace events. unit is the unit of start and duration: ms (default), s, or us. depth indents a child span.

Trace:

```openui-lang
root = Waterfall([{name: "POST /checkout", start: 0, duration: 412}, {name: "auth", start: 4, duration: 22, depth: 1}, {name: "load cart", start: 28, duration: 96, depth: 1}, {name: "SELECT items", start: 31, duration: 80, depth: 2}, {name: "charge card", start: 130, duration: 270, depth: 1, failed: true, detail: "card_declined"}], "Request trace")
```

From a HAR file:

```openui-lang
data = Query("file", {path: "/tmp/shop.har"}, {data: null})
root = Waterfall(data.data, "Page load")
```
