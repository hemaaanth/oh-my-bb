// Parses files for Query("file"): JSON, JSONL, CSV, TSV, or plain text, by extension.
// Ported from GenUI core/data.ts parseDataFile (Apache-2.0), trimmed to what Query("file") returns.
import { SpecError } from "./errors.js";

export const FILE_MAX_ROWS = 5000;

export type ParsedFile = { path: string; kind: "json" | "rows" | "text"; rows: unknown[]; data: unknown; text: string };

/** rows holds tabular data (CSV, TSV, JSONL, or a JSON list); data holds parsed JSON; text holds the raw text. */
export function parseFile(path: string, raw: string): ParsedFile {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const extension = /\.([^./\\]+)$/u.exec(path)?.[1]?.toLowerCase();
  const done = (kind: ParsedFile["kind"], data: unknown): ParsedFile => {
    const rows = Array.isArray(data) ? data : [];
    if (rows.length > FILE_MAX_ROWS) throw new SpecError(`${path} has ${rows.length} rows; the limit is ${FILE_MAX_ROWS}.`);
    return { path, kind, rows, data, text };
  };
  switch (extension) {
    case "json": case "sarif": case "har":
      try { return done("json", JSON.parse(text)); } catch (error) { throw new SpecError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    case "jsonl": case "ndjson":
      return done("rows", text.split(/\r?\n/u).flatMap((line, index) => {
        if (!line.trim()) return [];
        try { return [JSON.parse(line)]; } catch { throw new SpecError(`${path}: line ${index + 1} is not valid JSON.`); }
      }));
    case "csv":
      return done("rows", table(path, parseCsv(path, text)));
    case "tsv":
      return done("rows", table(path, text.split(/\r?\n/u).filter((line) => line !== "").map((line) => line.split("\t"))));
    default:
      return { path, kind: "text", rows: [], data: null, text };
  }
}

/** RFC 4180 records: `"` quotes a field, `""` escapes a quote, quoted fields may hold commas and newlines. */
export function parseCsv(path: string, text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let line = 1;
  let i = 0;
  const endField = () => { record.push(field); field = ""; };
  const endRecord = () => { endField(); if (record.length > 1 || record[0] !== "") records.push(record); record = []; };
  while (i < text.length) {
    const char = text[i];
    if (char === '"' && field === "") {
      const start = line;
      i++;
      for (;;) {
        if (i >= text.length) throw new SpecError(`${path}: a quoted field starting on line ${start} never closes.`);
        if (text[i] === '"') {
          if (text[i + 1] !== '"') break;
          field += '"';
          i += 2;
        } else {
          if (text[i] === "\n") line++;
          field += text[i++];
        }
      }
      i++;
      const next = text[i];
      if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") throw new SpecError(`${path}: unexpected text after a closing quote on line ${line}.`);
    } else if (char === ",") {
      endField();
      i++;
    } else if (char === "\n" || char === "\r") {
      endRecord();
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line++;
    } else {
      field += char;
      i++;
    }
  }
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

function table(path: string, records: readonly string[][]): Record<string, unknown>[] {
  const [header, ...rows] = records;
  if (!header) return [];
  if (new Set(header).size !== header.length) throw new SpecError(`${path}: the header names a column twice.`);
  return rows.map((row, index) => {
    if (row.length > header.length) throw new SpecError(`${path}: row ${index + 1} has ${row.length} cells; the header has ${header.length}.`);
    // fromEntries defines own properties, so a `__proto__` column stays plain data.
    return Object.fromEntries(header.map((name, column) => [name, cell(row[column] ?? "")]));
  });
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/u;

/** Numbers (JSON syntax, so "007" stays text), true/false, empty is null; anything else stays text. */
function cell(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (NUMBER.test(trimmed)) return Number(trimmed);
  const lower = trimmed.toLowerCase();
  return lower === "true" || lower === "false" ? lower === "true" : text;
}
