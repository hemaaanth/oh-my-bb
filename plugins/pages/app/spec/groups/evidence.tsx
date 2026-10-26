// Evidence: acceptance checks, side-by-side comparisons, where a number came from, and transcripts.
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { focusRing, seriesColor, type Group } from "../kit.js";
import { useHost } from "../host.js";
import { compareBest, formatClock } from "./evidence-logic.js";
import { AcceptanceView, ProvenanceView } from "../reports/EvidenceView.js";
import { CompareView } from "../reports/CompareView.js";
import { TranscriptView } from "../reports/TranscriptView.js";
import { isTranscriptLines } from "../transcript-input.js";

/** Items that have their main field yet: while a reply streams, the last one may be half written. */
const ready = <T,>(items: T[] | undefined, key: keyof T): T[] => (Array.isArray(items) ? items.filter((item) => item && typeof item[key] === "string" && item[key] !== "") : []);
const link = `cursor-pointer rounded-sm text-left text-primary underline underline-offset-2 ${focusRing}`;


const Acceptance = defineComponent({
  name: "Acceptance",
  props: z.object({ criteria: z.union([z.array(z.any()), z.record(z.string(), z.any()), z.string()]), title: z.string().optional(), columns: z.array(z.string()).optional() }),
  description: 'Acceptance checks as a list, a condition matrix, an owner/reviewer result, or CSV text. Existing {criterion,status,evidence,note} rows work. Matrices use {name, cells:{condition:result}} and optional columns. A missing result is not tested; done or owner-reported work is only claimed, not independently verified. Click a condition for its evidence, method, reviewer, run, and time. Required gaps and user actions stay visible.',
  component: ({ props }) => <AcceptanceView criteria={props.criteria} title={props.title} columns={props.columns} />,
});

const cellValue = z.union([z.string(), z.number(), z.null()]);

const Compare = defineComponent({
  name: "Compare",
  props: z.object({
    options: z.array(z.any()),
    rows: z.union([z.array(z.object({ criterion: z.string(), values: z.array(cellValue), better: z.enum(["high", "low"]).optional() })), z.string()]).optional(),
    best: z.string().optional(),
  }),
  description: 'Compare(options, rows, best?) keeps the scored options table. Compare(images, title?, mode?) compares screenshots: images is [{src,label?,meta?,note?}], reference first. mode is side, wipe, blink, or difference. Blink respects motion preferences and can be paused. Inspect changed pixels and regions, adjust tolerance, and zoom in the shared viewer. Different capture conditions and image sizes are disclosed; this is pixel evidence, not design approval.',
  component: ({ props }) => {
    if (!Array.isArray(props.rows)) return <CompareView images={props.options} title={props.rows} mode={props.best} />;
    const options = Array.isArray(props.options) ? props.options.filter((option): option is string => typeof option === "string") : [];
    const rows = ready(props.rows, "criterion");
    const { best, wins, leader } = compareBest(options.length, rows);
    const pick = props.best !== undefined && options.includes(props.best) ? options.indexOf(props.best) : leader;
    const scored = rows.some((row) => row.better);
    const cell = "px-3 py-1.5 text-left align-top first:pl-0";
    return <div className="min-w-0 overflow-x-auto"><table className="w-full border-collapse">
      <thead><tr><th className={`${cell} border-b border-border font-medium text-muted-foreground`}><span className="sr-only">Criterion</span></th>{options.map((option, i) => <th key={i} scope="col" className={`${cell} border-b-2 font-semibold ${i === pick ? "border-primary text-foreground" : "border-border text-foreground"}`}>{option}{i === pick ? <span className="block text-xs font-medium text-primary">Best</span> : null}</th>)}</tr></thead>
      <tbody>{rows.map((row, r) => <tr key={r} className="border-b border-border-hairline">
        <th scope="row" className={`${cell} font-normal text-muted-foreground`}>{row.criterion}{row.better ? <span className="sr-only"> ({row.better === "high" ? "higher" : "lower"} is better)</span> : null}</th>
        {options.map((_, i) => {
          const value = row.values?.[i];
          const top = best[r]?.[i];
          return <td key={i} className={`${cell} tabular-nums ${top ? "font-semibold text-success" : value === null || value === undefined ? "text-muted-foreground" : "text-foreground"}`}>{value === null || value === undefined || value === "" ? "—" : String(value)}{top ? <span className="sr-only"> (best)</span> : null}</td>;
        })}
      </tr>)}</tbody>
      {scored && options.length > 1 ? <tfoot><tr><th scope="row" className={`${cell} font-normal text-muted-foreground`}>Rows won</th>{wins.map((count, i) => <td key={i} className={`${cell} tabular-nums text-muted-foreground`}>{count}</td>)}</tr></tfoot> : null}
    </table></div>;
  },
});

const Provenance = defineComponent({
  name: "Provenance",
  props: z.object({
    claim: z.union([z.string(), z.array(z.any())]),
    steps: z.union([z.array(z.object({ step: z.string(), value: z.string().optional(), source: z.string().optional(), url: z.string().optional(), detail: z.string().optional() })), z.record(z.string(), z.any())]).optional(),
    value: z.string().optional(),
  }),
  description: 'Two evidence chains. Provenance(claim, steps, value?) keeps the existing source-to-number chain. Provenance(stages, expected?, title?) checks which revision or build reached a device or server. Each stage has {name,status,facts?,evidence?,detail?}; expected holds requested branch/sha/build facts. Missing receipts never pass. Expand a stage for full, copyable facts and evidence; identity changes are flagged.',
  component: ({ props }) => {
    const host = useHost();
    if (typeof props.claim !== "string") return <ProvenanceView stages={props.claim} expected={props.steps} title={props.value} />;
    const steps = ready(Array.isArray(props.steps) ? props.steps : undefined, "step");
    const dot = "absolute -left-[calc(1rem+0.5px)] -translate-x-1/2 top-1.5 size-2.5 rounded-full";
    return <ol className="m-0 flex list-none flex-col gap-3 border-l border-border-hairline py-0 pl-4 ml-1.5" aria-label={`How we got: ${props.claim ?? ""}`}>
      {steps.map((step, i) => <li key={i} className="relative flex flex-col gap-0.5">
        <span aria-hidden="true" className={`${dot} border border-input bg-background`} />
        <span className="flex flex-wrap items-baseline justify-between gap-x-3"><span className="text-foreground">{step.step}</span>{step.value ? <span className="tabular-nums font-medium text-foreground">{step.value}</span> : null}</span>
        {step.source ? <span className="text-muted-foreground">Source: {step.url ? <button type="button" onClick={() => host.openUrl(step.url!)} className={link}>{step.source}</button> : <span className="text-foreground">{step.source}</span>}</span> : step.url ? <button type="button" onClick={() => host.openUrl(step.url!)} className={`w-fit break-all ${link}`}>{step.url}</button> : null}
        {step.detail ? <span className="text-muted-foreground">{step.detail}</span> : null}
      </li>)}
      {props.claim ? <li className="relative flex flex-wrap items-baseline justify-between gap-x-3">
        <span aria-hidden="true" className={`${dot} bg-primary`} />
        <span className="font-semibold text-foreground">{props.claim}</span>{props.value ? <span className="tabular-nums font-semibold text-foreground">{props.value}</span> : null}
      </li> : null}
    </ol>;
  },
});

const Transcript = defineComponent({
  name: "Transcript",
  props: z.object({
    lines: z.union([z.array(z.any()), z.record(z.string(), z.any()), z.string()]),
    title: z.string().optional(),
    audio: z.string().optional(),
  }),
  description: 'Speaker-labelled call notes keep the existing [{speaker,text,time?,highlight?}] view. Transcript(tracks, title?, audio?) compares recognizer outputs: the first track is the reference. Each track has {name,words} or {name,text}; Whisper, Deepgram, AssemblyAI, SRT, and WebVTT work. Shows aligned words, word error rate, speaker errors, a zoomable timeline, and error navigation. audio is an optional scoped file or embedded data URL; no transcription service is called.',
  component: ({ props }) => {
    if (!isTranscriptLines(props.lines)) return <TranscriptView tracks={props.lines} title={props.title} audio={props.audio} />;
    const lines = ready(props.lines, "speaker").filter((line) => typeof line.text === "string");
    const speakers = [...new Set(lines.map((line) => line.speaker))];
    return <div className="flex min-w-0 flex-col gap-2">
      {props.title ? <h3 className="m-0 font-semibold text-foreground">{props.title}</h3> : null}
      <ol className="m-0 flex list-none flex-col p-0">{lines.map((line, i) => {
        const first = i === 0 || lines[i - 1]!.speaker !== line.speaker;
        const time = typeof line.time === "number" ? formatClock(line.time) : line.time;
        return <li key={i} className={`grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 border-l-2 pl-2 ${first && i > 0 ? "mt-2" : ""} ${line.highlight ? "border-primary bg-muted/40" : "border-transparent"}`}>
          <span className="pt-0.5 text-xs tabular-nums text-muted-foreground">{time ? <time>{time}</time> : null}</span>
          <span className="flex flex-col">
            {first ? <span className={`font-semibold ${seriesColor[speakers.indexOf(line.speaker) % seriesColor.length]}`}>{line.speaker}</span> : <span className="sr-only">{line.speaker}: </span>}
            <span className="text-foreground">{line.text}</span>
          </span>
        </li>;
      })}</ol>
    </div>;
  },
});

const comparisonImage = (shift: number) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="384" height="216"><rect width="384" height="216" fill="#f4f4f5"/><rect x="24" y="24" width="240" height="16" rx="4" fill="#27272a"/><rect x="24" y="60" width="320" height="8" rx="4" fill="#a1a1aa"/><rect x="${24 + shift}" y="134" width="96" height="36" rx="6" fill="#2563eb"/><text x="${45 + shift}" y="157" font-family="sans-serif" font-size="14" fill="white">Continue</text></svg>`)}`;


export const group: Group = {
  id: "evidence",
  name: "Evidence",
  entries: [
    { component: Acceptance, summary: "criteria with pass, fail, or unknown and evidence", examples: [
      { name: "Not proven", code: `root = Acceptance([{criterion: "Signup works on mobile", status: "pass", evidence: "https://ci.example.com/runs/812"}, {criterion: "Errors show inline", status: "pass", evidence: "app/signup.test.tsx:44"}, {criterion: "Page loads under 1 s", status: "unknown", note: "No perf run yet"}], "Signup form")` },
      { name: "Not done", code: `root = Acceptance([{criterion: "Exports CSV", status: "pass", evidence: "Tried with 10k rows"}, {criterion: "Keeps filters", status: "fail", evidence: "Filters reset after export"}])` },
      { name: "Done", code: `root = Acceptance([{criterion: "Old links redirect", status: "pass"}, {criterion: "No 404s in logs for a day", status: "pass", evidence: "logs/2026-10-16.txt"}])` },
      { name: "Device matrix", code: 'root = Acceptance([{name:"Upgrade keeps data",cells:{Phone:{status:"pass",by:"QA",evidence:"10,000 records retained"},Desktop:{status:"fail",note:"Filters reset"}}},{name:"Cold start",cells:{Phone:{status:"blocked",needs:"Unlock the test phone"},Desktop:"claimed"}},{name:"Deep links",cells:{Desktop:"pass"}}], "Release checks")' },
      { name: "CSV checks", code: 'root = Acceptance("criterion,status,evidence\\nBuilds,pass,Build log\\nExports CSV,unknown,No run recorded", "Import checks")' },
    ] },
    { component: Compare, summary: "options side by side, best marked", examples: [
      { name: "Scored", code: `root = Compare(["Postgres", "DynamoDB", "SQLite"], [{criterion: "Cost / month", values: ["$120", "$310", "$0"], better: "low"}, {criterion: "p99 read", values: ["4 ms", "9 ms", "1 ms"], better: "low"}, {criterion: "Max size (TB)", values: [64, null, 0.3], better: "high"}, {criterion: "Joins", values: ["Yes", "No", "Yes"]}])` },
      { name: "Chosen", code: `root = Compare(["Plan A", "Plan B"], [{criterion: "Weeks", values: [6, 4], better: "low"}, {criterion: "Risk", values: ["Low", "High"]}], "Plan A")` },
      { name: "Image difference", code: `root = Compare(${JSON.stringify([{src:comparisonImage(0),label:"Reference"},{src:comparisonImage(16),label:"Candidate"}])}, "Button position")` },
    ] },
    { component: Provenance, summary: "where a claim or number came from", examples: [
      { name: "Revenue", code: `root = Provenance("Q3 net revenue", [{step: "Exported paid invoices", value: "4,812 rows", source: "Stripe export", url: "https://dashboard.stripe.com/invoices"}, {step: "Summed amounts", value: "$1.31M", source: "billing.invoices"}, {step: "Took out refunds", value: "−$58k", source: "billing.refunds", detail: "Refunds dated inside Q3 only"}], "$1.25M")` },
      { name: "Installed build", code: 'root = Provenance([{name:"Checkout",status:"done",facts:{branch:"release",sha:"abc123456789"}},{name:"Build",status:"done",facts:{sha:"abc123456789",build:"204"}},{name:"Install",status:"done",facts:{branch:"main",build:"203",device:"Test phone"}},{name:"Launch"}], {branch:"release",build:"204"}, "Device receipts")' },
    ] },
    { component: Transcript, summary: "speaker-labelled lines with times", examples: [
      { name: "Call", code: `root = Transcript([{speaker: "Dana", time: 12, text: "Where do we stand on the import bug?"}, {speaker: "Lee", time: 18, text: "Found it. Dates in the old format break the parser."}, {speaker: "Lee", time: 25, text: "Fix is in review, should ship today.", highlight: true}, {speaker: "Dana", time: 71, text: "Great. Let's tell support once it's out."}], "Standup, Oct 16")` },
      { name: "Recognition comparison", code: 'root = Transcript([{name:"Reference",words:[{text:"Send",start:0,end:0.4},{text:"the",start:0.4,end:0.6},{text:"invoice",start:0.6,end:1.1},{text:"tomorrow",start:1.1,end:1.8}]},{name:"Recognizer",words:[{text:"Send",start:0,end:0.4},{text:"an",start:0.4,end:0.6},{text:"invoice",start:0.6,end:1.1},{text:"today",start:1.1,end:1.7}]}], "Check recognition errors")' },
    ] },
  ],
};
