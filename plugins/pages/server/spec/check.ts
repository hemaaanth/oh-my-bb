import { createParser, type ElementNode, type LibraryJSONSchema, type ParseResult } from "@openuidev/lang-core";
import { prepareSceneObjects } from "../../app/spec/gpu/expression.js";
import { sceneErrors } from "../../app/spec/gpu/scene.js";
import { shaderErrors, shaderInputNames, shaderPasses } from "../../app/spec/gpu/shader-args.js";
import type { Props } from "../../app/spec/gpu/values.js";
import { EDGES_ERROR, histogram, readSample } from "../../app/spec/groups/distribution.js";
import { evaluateSpec, specElements } from "./evaluate.js";
import { checkShader } from "./glsl-check.js";
import schema from "./library.schema.json";
import { checkApp } from "./app-lint.js";
import { annotateSources } from "../../app/spec/source-metadata.js";

export interface SpecIssue { severity: "error" | "warning"; kind: "parse" | "runtime" | "scene" | "shader" | "chart" | "probe"; component?: string; state?: string; message: string }
export interface SpecCheck { ok: boolean; checks: number; issues: SpecIssue[] }
export const MAX_SPEC_CHARS = 100_000;
const MAX_PROBES = 64;
const parser = createParser(schema as unknown as LibraryJSONSchema);
const inputs: Record<string, true> = { Slider: true, Stepper: true, Rating: true, Input: true, TextArea: true, Choice: true, Radio: true, Select: true, OptionCards: true, CheckBoxGroup: true, Checklist: true, Toggle: true, DateInput: true, Swatches: true, ListEditor: true, EditableTable: true };

function controls(value: unknown, out: ElementNode[] = []): ElementNode[] {
  if (Array.isArray(value)) for (const item of value) controls(item, out);
  else if (value && typeof value === "object") {
    const node = value as { type?: string; typeName?: string; props?: Record<string, unknown>; k?: string; name?: string; mappedProps?: Record<string, unknown> };
    if (node.type === "element" && node.typeName && inputs[node.typeName] === true && node.props) out.push(node as ElementNode);
    else if (node.k === "Comp" && node.name && inputs[node.name] === true && node.mappedProps) out.push({ type: "element", typeName: node.name, props: node.mappedProps, partial: false });
    for (const child of Object.values(value)) controls(child, out);
  }
  return out;
}

const optionValues = (raw: unknown): string[] => Array.isArray(raw) ? raw.flatMap((item: unknown) => {
  if (typeof item === "string") return [item];
  if (!item || typeof item !== "object") return [];
  const option = item as { value?: unknown; label?: unknown };
  const value = option.value ?? option.label;
  return typeof value === "string" ? [value] : [];
}) : [];

function probes(result: ParseResult, queries: ReadonlyMap<string, unknown>): { variable: string; value: unknown }[] {
  const candidates = new Map<string, { variable: string; value: unknown }>();
  for (const control of controls(result.root ?? result.rootExpression)) {
    const binding = control.props.value as { k?: string; n?: string } | undefined;
    if (binding?.k !== "StateRef" || !binding.n || !Object.hasOwn(result.stateDeclarations, binding.n)) continue;
    const variable = binding.n;
    const props = evaluateSpec({ ...result, root: control, rootExpression: undefined }, queries).root?.props ?? {};
    const current = result.stateDeclarations[variable];
    let values: unknown[] = [];
    if (control.typeName === "Slider" || control.typeName === "Stepper") {
      const start = typeof current === "number" ? current : 0;
      const min = typeof props.min === "number" ? props.min : Math.min(0, start - 1);
      values = [min, typeof props.max === "number" ? Math.max(min, props.max) : start + 1];
    } else if (control.typeName === "Rating") values = [0, Math.max(1, Math.min(10, Number(props.max ?? 5)))];
    else if (control.typeName === "Toggle") values = [false, true];
    else if (control.typeName === "CheckBoxGroup" || control.typeName === "Checklist" || props.multiple === true) {
      const options = optionValues(props.options ?? props.items);
      values = [[], ...options.map((value) => [value]), options];
    } else if (control.typeName === "Choice" || control.typeName === "Radio" || control.typeName === "Select" || control.typeName === "OptionCards") values = optionValues(props.options);
    else if (control.typeName === "Swatches") values = optionValues(props.colors);
    else if (control.typeName === "DateInput") values = ["", props.min ?? props.max ?? "2000-01-01", props.max ?? props.min ?? "2099-12-31"];
    else if (control.typeName === "ListEditor") values = [[], ["Example"]];
    else if (control.typeName === "EditableTable") {
      const columns = Array.isArray(props.columns) ? props.columns : [];
      values = [[], [Object.fromEntries(columns.map((column: string | { key: string; type?: string }) => [typeof column === "string" ? column : column.key, typeof column === "string" ? "Example" : column.type === "number" ? 0 : column.type === "boolean" ? false : "Example"]))]];
    } else values = ["", "Example"];
    for (const value of values) {
      if (JSON.stringify(value) === JSON.stringify(current)) continue;
      candidates.set(`${variable}:${JSON.stringify(value)}`, { variable, value });
    }
  }
  return [...candidates.values()];
}

/** Validate native OpenUI, including independent bound-control edges and Scene times 0 and 1. */
export function checkOpenUi(code: string, queries: ReadonlyMap<string, unknown> = new Map(), parsed?: ParseResult): SpecCheck {
  const issues: SpecIssue[] = [];
  let checks = 0, hasErrors = false;
  const seen = new Set<string>();
  const report = (issue: SpecIssue) => {
    if (issue.severity === "error") hasErrors = true;
    const key = JSON.stringify(issue);
    if (!seen.has(key) && issues.length < 100) { seen.add(key); issues.push(issue); }
  };
  if (code.length > MAX_SPEC_CHARS) return { ok: false, checks, issues: [{ severity: "error", kind: "parse", message: `A UI check accepts at most ${MAX_SPEC_CHARS} characters.` }] };
  let result: ParseResult;
  try { result = parsed ?? parser.parse(code); }
  catch (error) { return { ok: false, checks, issues: [{ severity: "error", kind: "parse", message: error instanceof Error ? error.message : String(error) }] }; }
  annotateSources(result);
  for (const error of result.meta.errors) report({ severity: error.severity ?? "error", kind: "parse", component: error.component, message: error.message });
  if (result.meta.incomplete) report({ severity: "error", kind: "parse", message: "The program is incomplete." });
  for (const name of result.meta.unresolved) report({ severity: "error", kind: "parse", message: `Unresolved reference ${name}.` });
  const shaderChecks = new Map<string, string[]>();
  const run = (overrides: Record<string, unknown>, state?: string) => {
    checks++;
    const evaluated = evaluateSpec(result, queries, overrides);
    for (const message of evaluated.errors) report({ severity: "error", kind: "runtime", state, message });
    if (!evaluated.root) { report({ severity: "error", kind: "runtime", state, message: "The program does not produce a root component." }); return; }
    for (const node of specElements(evaluated.root)) {
      if (node.typeName === "Scene") {
        const objects = prepareSceneObjects(node.props.objects, node.props.inputs as Record<string, number | boolean> | undefined);
        for (const time of [0, 1]) for (const message of sceneErrors({ ...node.props, objects } as Props, time)) report({ severity: "error", kind: "scene", component: "Scene", state: `${state ?? "default"}, t=${time}`, message });
      } else if (node.typeName === "Shader") {
        const props = node.props as Props;
        const passes = shaderPasses(props), names = shaderInputNames(props);
        const textures = Array.isArray(props.textures) ? props.textures.length : 0;
        const key = JSON.stringify([passes, names, textures]);
        let errors = shaderChecks.get(key);
        if (!errors) { errors = checkShader(passes, names, textures); shaderChecks.set(key, errors); }
        for (const message of [...shaderErrors(props), ...errors]) report({ severity: "error", kind: "shader", component: "Shader", state, message });
      } else if (node.typeName === "Chart" && node.props.type === "histogram") {
        const series = Array.isArray(node.props.series) ? node.props.series as ElementNode[] : [];
        const samples = series.map((series) => readSample(String(series.props?.name ?? ""), Array.isArray(series.props?.values) ? series.props.values : []).values);
        if (!histogram(Array.isArray(node.props.labels) ? node.props.labels : [], samples)) report({ severity: "error", kind: "chart", component: "Chart", state, message: EDGES_ERROR });
      } else if (node.typeName === "App" && typeof node.props.html === "string") {
        const app = checkApp(node.props.html);
        if (!app.ok) report({ severity: "error", kind: "runtime", component: "App", state, message: app.report });
      }
    }
  };
  run({});
  const boundaries = probes(result, queries);
  for (const { variable, value } of boundaries.slice(0, MAX_PROBES)) run({ [variable]: value }, `${variable}=${JSON.stringify(value)}`);
  if (boundaries.length > MAX_PROBES) report({ severity: "warning", kind: "probe", message: `Checked the first ${MAX_PROBES} bound-control edges; ${boundaries.length - MAX_PROBES} remain.` });
  return { ok: !hasErrors, checks, issues };
}

export function parseCheckedSpec(code: string): ParseResult {
  if (code.length > MAX_SPEC_CHARS) throw new Error(`A UI check accepts at most ${MAX_SPEC_CHARS} characters.`);
  const result = parser.parse(code);
  annotateSources(result);
  return result;
}
