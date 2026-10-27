import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostClient, runCommand } from "./host-contract.js";

const MAX_RETURNED_ROWS = 2_000;
const QUERY_TIMEOUT_MS = 60_000;

export const clickhouseQueryInputSchema = z.object({
  sql: z.string().trim().min(1).max(20_000).describe("One read-only ClickHouse SELECT or WITH ... SELECT statement."),
}).strict();

const clickhouseOutputSchema = z.object({
  meta: z.array(z.object({ name: z.string(), type: z.string() })),
  data: z.array(z.array(z.unknown())),
  rows: z.number().int().nonnegative().optional(),
});

const forbiddenWords = [
  "insert", "update", "delete", "alter", "drop", "create", "rename", "truncate",
  "optimize", "attach", "detach", "set", "use", "grant", "revoke", "kill",
  "system", "backup", "restore", "undrop", "move", "replace",
] as const;

const forbiddenFunctions = [
  "file", "url", "remote", "remoteSecure", "s3", "s3Cluster", "hdfs", "azureBlobStorage",
  "mysql", "postgresql", "mongodb", "redis", "jdbc", "odbc", "executable", "executablePool",
] as const;

function stripComments(sql: string): string {
  const output: string[] = [];
  let quote: "'" | "\"" | "`" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (quote) {
      output.push(character);
      if (character === "\\") {
        if (next !== undefined) output.push(next);
        index += 1;
      } else if (character === quote) {
        if (next === quote) {
          output.push(next);
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      output.push(character);
    } else if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      output.push(" ");
      index = end === -1 ? sql.length : end + 1;
    } else if ((character === "-" && next === "-") || character === "#") {
      const end = sql.indexOf("\n", index + 1);
      output.push(" ");
      index = end === -1 ? sql.length : end - 1;
    } else {
      output.push(character);
    }
  }
  return output.join("");
}

function maskStrings(sql: string): string {
  return sql.replace(/'(?:''|\\.|[^'])*'/gu, "''");
}

export function guardClickhouseQuery(sql: string): string {
  const normalized = stripComments(sql).trim().replace(/;+\s*$/gu, "").trim();
  if (!normalized) throw new Error("Query is empty");

  const masked = maskStrings(normalized);
  if (masked.includes(";")) throw new Error("Only one SQL statement is allowed");
  if (!/^\s*(?:select\b|with\b[\s\S]*\bselect\b)/iu.test(masked)) {
    throw new Error("Only SELECT or WITH ... SELECT queries are allowed");
  }
  for (const word of forbiddenWords) {
    if (new RegExp(`\\b${word}\\b`, "iu").test(masked)) throw new Error(`Forbidden SQL keyword: ${word.toUpperCase()}`);
  }
  for (const name of forbiddenFunctions) {
    if (new RegExp(`\\b${name}\\s*\\(`, "iu").test(masked)) throw new Error(`External table function is not allowed: ${name}`);
  }
  if (/\binto\s+outfile\b/iu.test(masked)) throw new Error("INTO OUTFILE is not allowed");
  if (/\bformat\s+[a-z_][a-z0-9_]*\s*$/iu.test(masked)) throw new Error("FORMAT is controlled by the query tool");
  if (/\bsettings\s+[a-z_][a-z0-9_]*\s*=/iu.test(masked)) throw new Error("SETTINGS is controlled by the query tool");
  return normalized;
}

export interface ClickhouseQueryResult {
  sql: string;
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

export function parseClickhouseOutput(output: string, sql: string): ClickhouseQueryResult {
  const parsed = clickhouseOutputSchema.parse(JSON.parse(output));
  const rows = parsed.data.slice(0, MAX_RETURNED_ROWS).map((values) =>
    Object.fromEntries(parsed.meta.map((column, index) => [column.name, values[index] ?? null])),
  );
  const rowCount = parsed.rows ?? parsed.data.length;
  return {
    sql,
    columns: parsed.meta,
    rows,
    rowCount,
    truncated: rowCount > rows.length || parsed.data.length > rows.length,
  };
}

export async function runClickhouseQuery(
  bb: BbPluginApi,
  input: { hostId: string; workspacePath: string; sql: string; signal?: AbortSignal },
): Promise<ClickhouseQueryResult> {
  input.signal?.throwIfAborted();
  const sql = guardClickhouseQuery(input.sql);
  const args = [
    "clickhouse", "client",
    "--readonly", "1",
    "--max_execution_time", "30",
    "--max_result_rows", String(MAX_RETURNED_ROWS + 1),
    "--result_overflow_mode", "break",
    "--max_result_bytes", String(10 * 1024 * 1024),
    "--max_rows_to_read", "500000000",
    "--max_memory_usage", "4000000000",
  ];
  const result = await runCommand(hostClient(bb), input.hostId, {
    cwd: input.workspacePath,
    command: "~/.local/bin/bb-project-env-run",
    args,
    stdin: `${sql}\nFORMAT JSONCompact\n`,
    timeoutMs: QUERY_TIMEOUT_MS,
  }, input.signal);
  input.signal?.throwIfAborted();
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `ClickHouse exited with code ${result.exitCode}`);
  return parseClickhouseOutput(result.stdout, sql);
}
