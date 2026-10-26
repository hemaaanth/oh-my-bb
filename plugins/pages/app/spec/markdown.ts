import type { ElementNode, ParseResult } from "@openuidev/lang-core";
import { evaluateSpec, type ResolveQuery } from "../../server/spec/evaluate.js";
import { toMarkdown } from "./reports/markdown.js";
import type { ComponentName, UiNode, Value } from "./reports/types.js";
import { snippetLines } from "./file-lines.js";
import { readCoverageInput, type CoverageMetric } from "./coverage-input.js";
import { formatPercent, percent } from "./reports/coverage.js";
import { manualBenchmarks } from "./benchmark-input.js";
import { isTranscriptLines } from "./transcript-input.js";
import { mapMarkers } from "./map-input.js";

export interface MarkdownSnapshot {
  state?: Record<string, unknown>;
  resolveQuery?: ResolveQuery;
  textFiles?: ReadonlyMap<string, string>;
  searches?: ReadonlyMap<string, unknown>;
}
const fields: Record<string, true> = { Input: true, TextArea: true, Slider: true, Stepper: true, DateInput: true, Rating: true, Toggle: true, Choice: true, Radio: true, CheckBoxGroup: true, Checklist: true, Select: true, OptionCards: true, Swatches: true, ListEditor: true, EditableTable: true };
const parts: Record<string, true> = { Source: true, Photo: true, Marker: true, Area: true, Hotspot: true, Series: true };
const aliases: Record<string, ComponentName> = { Stat: "Metric", Stats: "Row", CheckBoxGroup: "Checklist", IconButton: "Button" };
const text = (value: unknown): string => value == null ? "" : String(value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const cell = (value: unknown): string => text(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const table = (columns: unknown[], rows: unknown[][]): string => [`| ${columns.map(cell).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map(row => `| ${row.map(cell).join(" | ")} |`)].join("\n");
const prose = (lines: unknown[]): string => lines.map(text).filter(Boolean).join("\n\n");
const fence = (source: string, language = ""): string => {
  const ticks = "`".repeat(Math.max(3, ...(source.match(/`+/g) ?? []).map(run => run.length + 1)));
  return `${ticks}${language}\n${source.replace(/\n$/, "")}\n${ticks}`;
};

/** Uses the same native evaluation as the Renderer. No second UI language or interpreter. */
export function snapshotMarkdown(parsed: ParseResult, snapshot: MarkdownSnapshot = {}): string {
  const parseErrors = parsed.meta.errors.filter(error => error.severity !== "warning");
  if (parseErrors.length || parsed.meta.incomplete || parsed.meta.unresolved.length) throw new Error(parseErrors.map(error => error.message).join("\n") || "Wait for a complete, valid component before copying.");
  const result = evaluateSpec(parsed, new Map(), snapshot.state, snapshot.resolveQuery);
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  if (!result.root) throw new Error("The component has no exportable content yet.");
  let ordinal = 0;
  const make = (type: UiNode["type"], props: Record<string, Value>): UiNode => ({ kind: "node", type, key: String(ordinal++), props });
  const markdown = (content: string): UiNode => make("Text", { text: content });
  const converted = (value: unknown, form?: string): Value => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object") return value as Value;
    if (Array.isArray(value)) return value.map(item => converted(item, form));
    const object = value as Record<string, unknown>;
    if (object.type === "element" && typeof object.typeName === "string") return convertNode(object as unknown as ElementNode, form);
    return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined).map(([k, v]) => [k, converted(v, form)]));
  };
  const renderChildren = (children: unknown, form?: string): string => toMarkdown(list(children).map(child => converted(child, form)).filter((v): v is UiNode => !!v && typeof v === "object" && "kind" in v && v.kind === "node"));
  const convertNode = (node: ElementNode, form?: string): Value => {
    const name = node.typeName;
    const raw = node.props;
    const ownForm = name === "Form" ? text(raw.name) : form;
    const props = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined).map(([key, value]) => [key, converted(value, ownForm)]));
    if (parts[name] === true) return props;
    if (fields[name] === true) {
      const saved = ownForm ? record(snapshot.state?.[ownForm]) : snapshot.state ?? {};
      const entry = record(saved[text(raw.name)]);
      const value = Object.hasOwn(entry, "value") ? entry.value : raw.value ?? (name === "EditableTable" ? raw.rows : name === "Slider" ? raw.min ?? 0 : name === "Toggle" ? false : null);
      props.value = { kind: "binding", name: text(raw.name), value: converted(value, ownForm) };
      if (name === "Checklist") props.options = converted(raw.items, ownForm);
      if (name === "Swatches") props.colors = converted(raw.colors, ownForm);
    }
    if (Array.isArray(raw.__pagesSources)) props.loadedFrom = converted(raw.__pagesSources);
    switch (name) {
      case "Heading": return markdown(`## ${text(raw.text)}`);
      case "Tag": return markdown(text(raw.text));
      case "Chips": return markdown(list(raw.items).map(item => typeof item === "string" ? item : text(record(record(item).props).text)).join(" · "));
      case "Callout": props.text = converted(raw.body); break;
      case "Stat": props.note = converted(raw.change); break;
      case "Stats": props.children = converted(raw.items, form); break;
      case "Carousel": props.children = converted(raw.items, form); break;
      case "Form": props.children = converted([...list(raw.fields), ...list(raw.buttons)], ownForm); break;
      case "Accordion": return markdown(list(raw.items).map(item => { const p = record(record(item).props); return prose([`**${text(p.title)}**`, renderChildren(p.children, form)]); }).join("\n\n"));
      case "AccordionItem": case "Tab": return make("Stack", { children: converted(raw.children, form) });
      case "Modal": return markdown(prose([`**${text(raw.title ?? raw.label)}**`, renderChildren(raw.children, form)]));
      case "Tabs": return markdown(list(raw.tabs).map(tab => { const p = record(record(tab).props); return prose([`### ${text(p.label)}`, renderChildren(p.children, form)]); }).join("\n\n"));
      case "Snippet": return markdown(prose([text(raw.label), fence(text(raw.text))]));
      case "FileCode": {
        const path = text(raw.file), source = snapshot.textFiles?.get(path);
        if (source === undefined) throw new Error(`The source excerpt ${path} is still loading.`);
        const excerpt = snippetLines(source, typeof raw.from === "number" ? raw.from : null, typeof raw.to === "number" ? raw.to : null);
        if (excerpt.error !== null) throw new Error(excerpt.error);
        return markdown(prose([`\`${path}\``, fence(excerpt.code, path.split(".").pop())]));
      }
      case "Diagram": {
        const nodes = list(raw.nodes).map(record), edges = list(raw.edges).map(record);
        const labels = new Map(nodes.map(n => [text(n.id), text(n.label ?? n.id)]));
        return markdown(prose(["**Diagram**", edges.length ? edges.map(edge => `- ${labels.get(text(edge.from)) ?? text(edge.from)} → ${labels.get(text(edge.to)) ?? text(edge.to)}${edge.label ? ` (${text(edge.label)})` : ""}`).join("\n") : [...labels.values()].join(" · ")]));
      }
      case "Chart": props.series = Object.fromEntries(list(raw.series).map(item => { const p = record(record(item).props); return [text(p.name), converted(p.values)]; })); break;
      case "Gallery": props.images = converted(raw.items, form); break;
      case "BeforeAfter": props.images = converted(list(raw.items).map(item => ({ src: record(item).src, caption: record(item).caption ?? record(item).label, alt: record(item).alt }))); return make("Gallery", props);
      case "Hotspots": props.points = converted(raw.points, form); break;
      case "ImageSearch": {
        const found = snapshot.searches?.get(text(raw.query));
        const images = Array.isArray(found) ? found : list(record(found).images);
        if (!images.length) return markdown(`Image search: ${text(raw.query)} (no loaded images).`);
        return markdown(images.map(image => { const i = record(image); return `![${cell(i.title)}](${text(i.url)})\n\n${text(i.creator)} · ${text(i.license)}${i.sourceUrl ? ` · [Source](${text(i.sourceUrl)})` : ""}`; }).join("\n\n"));
      }
      case "Map": props.places = converted(mapMarkers(list(raw.markers)).map(marker => ({ name: marker.title, lat: Array.isArray(marker.at) ? marker.at[0] : undefined, lng: Array.isArray(marker.at) ? marker.at[1] : undefined, note: [marker.description, typeof marker.at === "string" && marker.at !== marker.title ? `Location: ${marker.at}` : null].filter(Boolean).join(". "), day: marker.day, wiki: marker.wiki }))); props.route = converted(record(raw.areas).route); props.tour = converted(record(raw.areas).tour); break;
      case "Coverage": {
        const report = readCoverageInput(raw.report, raw.metric as CoverageMetric | undefined);
        if (!report.ok) throw new Error(report.error);
        const metrics = (["lines", "statements", "functions", "branches"] as const).filter(metric => report.report.total[metric] !== null);
        const rows = [report.report.total, ...report.report.files].map((file, index) => [index ? report.report.files[index - 1]!.path : "Total", ...metrics.map(metric => {
          const ratio = file[metric], value = percent(ratio);
          return value === null || !ratio ? "No data" : `${formatPercent(value)} (${ratio.covered}/${ratio.total})`;
        })]);
        return markdown(prose([raw.title ?? "Coverage", table(["File", ...metrics], rows), ...report.report.files.filter(file => file.uncovered?.length).map(file => `${file.path}: uncovered lines ${file.uncovered!.map(range => range.start === range.end ? range.start : `${range.start}-${range.end}`).join(", ")}`)]));
      }
      case "Benchmark": {
        const rows = manualBenchmarks(raw.results, typeof raw.unit === "string" ? raw.unit : undefined);
        if (rows !== null) return markdown(prose([raw.title ?? "Benchmark", table(["Result", "Before", "After", "Unit", "Noise", "Conditions"], rows.map(row => [row.name, row.before ?? "Not recorded", row.after, row.unit, row.noise ?? "Not recorded", row.comparable ? row.partial.length ? "Partly recorded" : "No recorded mismatch" : "Different conditions"])), ...rows.flatMap(row => [
          row.contextBefore ? `${row.name} before: ${JSON.stringify(row.contextBefore)}` : null,
          row.contextAfter ? `${row.name} after: ${JSON.stringify(row.contextAfter)}` : null,
          row.min !== null || row.max !== null || row.median !== null ? `${row.name}: ${[row.min !== null ? `min ${row.min}` : null, row.max !== null ? `max ${row.max}` : null, row.median !== null ? `median ${row.median}` : null].filter(Boolean).join(", ")} ${row.unit}` : null,
          row.beforeSamples.length || row.samples.length ? `${row.name}: ${row.beforeSamples.length} before samples; ${row.samples.length} after samples` : null,
          row.note,
        ])]));
        break;
      }
      case "Findings": props.items = converted(raw.findings); break;
      case "Dependencies": props.report = converted(raw.packages); break;
      case "Logs": props.output = converted(raw.log); props.command = converted(raw.title); break;
      case "Pipeline": props.run = converted(raw.jobs); break;
      case "Json": props.value = converted(raw.data); props.label = converted(raw.title); break;
      case "Board": props.items = converted(raw.cards); break;
      case "Decision": return markdown(prose([`**${text(raw.question)}**`, ...list(raw.options).map(option => { const o = record(option); return prose([`**${text(o.name)}${o.name === raw.recommend ? " (recommended)" : ""}**`, ...list(o.pros).map(p => `- Pro: ${text(p)}`), ...list(o.cons).map(p => `- Con: ${text(p)}`), o.note]); })]));
      case "Estimate": props.tasks = converted(list(raw.tasks).map(task => ({ ...record(task), label: record(task).task }))); break;
      case "Plan": props.steps = converted(list(raw.steps).map(step => ({ ...record(step), title: record(step).step }))); break;
      case "Status": return markdown(prose([`**${text(raw.state)}**`, raw.summary, ...["highlights", "risks", "next"].flatMap(key => list(raw[key]).map(item => `- ${text(item)}`))]));
      case "Changes": return markdown(prose([raw.title ?? "Changes", table(["File", "Status", "Added", "Removed"], list(raw.files).map(file => { const f = record(file); return [f.path, f.status, f.additions ?? 0, f.deletions ?? 0]; }))]));
      case "Commits": return markdown(prose([raw.title ?? "Commits", table(["Commit", "Subject", "Author"], list(raw.commits).map(commit => { const c = record(commit); return [c.sha, c.subject, c.author]; }))]));
      case "Threads": return markdown(prose([raw.title ?? "Threads", table(["Thread", "Status", "Branch"], list(raw.threads).map(thread => { const t = record(thread); return [t.title, t.status, t.branch]; }))]));
      case "Environments": return markdown(prose([raw.title ?? "Environments", table(["Environment", "Branch", "Status", "Path"], list(raw.environments).map(environment => { const e = record(environment); return [e.name, e.branch, e.status, e.path]; }))]));
      case "PullRequest": { const p = record(raw.pullRequest); return markdown(prose([p.title ? `**${text(p.title)}**` : raw.message, p.url ? `[Pull request](${text(p.url)})` : "", p.state, p.base && p.head ? `${text(p.head)} → ${text(p.base)}` : ""])); }
      case "Compare": if (!Array.isArray(raw.rows)) return make("Compare", { images: converted(raw.options), title: converted(raw.rows) }); return markdown(prose([table(["Criterion", ...list(raw.options)], list(raw.rows).map(row => { const r = record(row); return [r.criterion, ...list(r.values)]; })), raw.best ? `Recommended: ${text(raw.best)}` : ""]));
      case "Provenance": if (typeof raw.claim !== "string") return make("Provenance", { stages: converted(raw.claim), expected: converted(raw.steps), title: converted(raw.value) }); return markdown(prose([`**${text(raw.claim)}${raw.value ? `: ${text(raw.value)}` : ""}**`, ...list(raw.steps).map(step => { const s = record(step); return `- ${text(s.step)}${s.value ? `: ${text(s.value)}` : ""}${s.source ? ` · ${text(s.source)}` : ""}${s.url ? ` (${text(s.url)})` : ""}${s.detail ? ` · ${text(s.detail)}` : ""}`; })]));
      case "Transcript": if (!isTranscriptLines(raw.lines)) return make("Transcript", { tracks: converted(raw.lines), title: converted(raw.title), audio: converted(raw.audio) }); return markdown(prose([raw.title, ...raw.lines.map(line => `${line.time == null ? "" : `${line.time} `}**${line.speaker}:** ${line.text}`)]));
      case "App": return markdown(`Interactive app: **${text(raw.name)}**. Open it in Pages to use it.`);
    }
    const type = Object.hasOwn(aliases, name) ? aliases[name]! : name as ComponentName;
    return make(type, props);
  };
  const root = converted(result.root);
  if (!root || typeof root !== "object" || !("kind" in root) || root.kind !== "node") throw new Error("The component cannot be exported.");
  return toMarkdown([root as UiNode]);
}
