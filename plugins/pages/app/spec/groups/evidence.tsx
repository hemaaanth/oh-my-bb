// Evidence: acceptance checks, side-by-side comparisons, where a number came from, and transcripts.
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { focusRing, seriesColor, type Group } from "../kit.js";
import { useHost } from "../host.js";
import { acceptanceVerdict, compareBest, evidenceShape, formatClock, type AcceptanceStatus } from "./evidence-logic.js";

/** Items that have their main field yet: while a reply streams, the last one may be half written. */
const ready = <T,>(items: T[] | undefined, key: keyof T): T[] => (Array.isArray(items) ? items.filter((item) => item && typeof item[key] === "string" && item[key] !== "") : []);
const link = `cursor-pointer rounded-sm text-left text-primary underline underline-offset-2 ${focusRing}`;

function Evidence({ text }: { text: string }) {
  const host = useHost();
  const shape = evidenceShape(text);
  if (shape.kind === "url") return <button type="button" onClick={() => host.openUrl(shape.text)} className={`break-all ${link}`}>{shape.text}</button>;
  return shape.kind === "file" ? <code className="break-all font-mono text-xs text-foreground">{shape.text}</code> : <span className="text-foreground">{shape.text}</span>;
}

const verdictText = { success: "text-success", warning: "text-warning", danger: "text-destructive", neutral: "text-muted-foreground" } as const;
const mark: Record<AcceptanceStatus, [string, string, string]> = { pass: ["✓", "Pass", "text-success"], fail: ["✕", "Fail", "text-destructive"], unknown: ["?", "Unknown", "text-muted-foreground"] };

const Acceptance = defineComponent({
  name: "Acceptance",
  props: z.object({ criteria: z.array(z.object({ criterion: z.string(), status: z.enum(["pass", "fail", "unknown"]).optional(), evidence: z.string().optional(), note: z.string().optional() })), title: z.string().optional() }),
  description: 'Acceptance criteria with a result each and the evidence for it. status "pass", "fail", or "unknown" (default). evidence is a link, a file path (shown as code), or short text. The verdict on top says Done only when every criterion passes; unknown is never a pass.',
  component: ({ props }) => {
    const items = ready(props.criteria, "criterion");
    const verdict = acceptanceVerdict(items);
    return <div className="flex min-w-0 flex-col gap-2">
      {props.title ? <h3 className="m-0 font-semibold text-foreground">{props.title}</h3> : null}
      <p role="status" className="m-0"><span className={`font-semibold ${verdictText[verdict.tone]}`}>{verdict.headline}</span><span className="text-muted-foreground"> · {verdict.line}</span></p>
      <ul className="m-0 flex list-none flex-col p-0">{items.map((item, i) => {
        const [symbol, label, color] = mark[item.status ?? "unknown"] ?? mark.unknown;
        return <li key={i} className="flex gap-2.5 border-b border-border-hairline py-1.5 last:border-b-0">
          <span role="img" aria-label={label} title={label} className={`w-4 shrink-0 text-center font-semibold ${color}`}>{symbol}</span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-foreground">{item.criterion}</span>
            {item.evidence ? <span className="flex min-w-0 gap-1.5 text-muted-foreground"><span className="shrink-0">Evidence:</span><Evidence text={item.evidence} /></span> : null}
            {item.note ? <span className="text-muted-foreground">{item.note}</span> : null}
          </span>
        </li>;
      })}</ul>
    </div>;
  },
});

const cellValue = z.union([z.string(), z.number(), z.null()]);

const Compare = defineComponent({
  name: "Compare",
  props: z.object({
    options: z.array(z.string()),
    rows: z.array(z.object({ criterion: z.string(), values: z.array(cellValue), better: z.enum(["high", "low"]).optional() })),
    best: z.string().optional(),
  }),
  description: 'Options side by side across criteria. options are the column names; each row has a criterion and one value per option, in the same order (null for none). Give better "high" or "low" on rows of numbers: the best cell is marked, and the option that wins the most rows is marked as best. Text like "$12" or "120 ms" counts by its leading number. best names the overall pick and overrides that.',
  component: ({ props }) => {
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
    claim: z.string(),
    steps: z.array(z.object({ step: z.string(), value: z.string().optional(), source: z.string().optional(), url: z.string().optional(), detail: z.string().optional() })),
    value: z.string().optional(),
  }),
  description: 'Where a claim or number came from: the steps from the sources to the claim, in order. Each step says what was done, the value it gave, and its source (a link when url is set). The claim and its value close the chain. Example step: {step: "Summed paid invoices", value: "$1.2M", source: "billing.invoices"}.',
  component: ({ props }) => {
    const host = useHost();
    const steps = ready(props.steps, "step");
    const dot = "absolute -left-[1.1875rem] top-1.5 size-2.5 rounded-full";
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
    lines: z.array(z.object({ speaker: z.string(), text: z.string(), time: z.union([z.string(), z.number()]).optional(), highlight: z.boolean().optional() })),
    title: z.string().optional(),
  }),
  description: 'Speaker-labelled lines of a conversation or call. time is seconds from the start (shown as m:ss) or text like "10:42". A name shows once per run of lines from the same speaker. Set highlight on the lines that matter; they get a bar.',
  component: ({ props }) => {
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

export const group: Group = {
  id: "evidence",
  name: "Evidence",
  entries: [
    { component: Acceptance, summary: "criteria with pass, fail, or unknown and evidence", examples: [
      { name: "Not proven", code: `root = Acceptance([{criterion: "Signup works on mobile", status: "pass", evidence: "https://ci.example.com/runs/812"}, {criterion: "Errors show inline", status: "pass", evidence: "app/signup.test.tsx:44"}, {criterion: "Page loads under 1 s", status: "unknown", note: "No perf run yet"}], "Signup form")` },
      { name: "Not done", code: `root = Acceptance([{criterion: "Exports CSV", status: "pass", evidence: "Tried with 10k rows"}, {criterion: "Keeps filters", status: "fail", evidence: "Filters reset after export"}])` },
      { name: "Done", code: `root = Acceptance([{criterion: "Old links redirect", status: "pass"}, {criterion: "No 404s in logs for a day", status: "pass", evidence: "logs/2026-10-16.txt"}])` },
    ] },
    { component: Compare, summary: "options side by side, best marked", examples: [
      { name: "Scored", code: `root = Compare(["Postgres", "DynamoDB", "SQLite"], [{criterion: "Cost / month", values: ["$120", "$310", "$0"], better: "low"}, {criterion: "p99 read", values: ["4 ms", "9 ms", "1 ms"], better: "low"}, {criterion: "Max size (TB)", values: [64, null, 0.3], better: "high"}, {criterion: "Joins", values: ["Yes", "No", "Yes"]}])` },
      { name: "Chosen", code: `root = Compare(["Plan A", "Plan B"], [{criterion: "Weeks", values: [6, 4], better: "low"}, {criterion: "Risk", values: ["Low", "High"]}], "Plan A")` },
    ] },
    { component: Provenance, summary: "where a claim or number came from", examples: [
      { name: "Revenue", code: `root = Provenance("Q3 net revenue", [{step: "Exported paid invoices", value: "4,812 rows", source: "Stripe export", url: "https://dashboard.stripe.com/invoices"}, {step: "Summed amounts", value: "$1.31M", source: "billing.invoices"}, {step: "Took out refunds", value: "−$58k", source: "billing.refunds", detail: "Refunds dated inside Q3 only"}], "$1.25M")` },
    ] },
    { component: Transcript, summary: "speaker-labelled lines with times", examples: [
      { name: "Call", code: `root = Transcript([{speaker: "Dana", time: 12, text: "Where do we stand on the import bug?"}, {speaker: "Lee", time: 18, text: "Found it. Dates in the old format break the parser."}, {speaker: "Lee", time: 25, text: "Fix is in review, should ship today.", highlight: true}, {speaker: "Dana", time: 71, text: "Great. Let's tell support once it's out."}], "Standup, Oct 16")` },
    ] },
  ],
};
