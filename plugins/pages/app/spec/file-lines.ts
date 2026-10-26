// Ported from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
export const MAX_SNIPPET_LINES = 400;

/** The lines a Snippet shows, or a user-facing reason it cannot show them. */
export type SnippetLines = { readonly code: string; readonly error: null } | { readonly code: null; readonly error: string };

/** Why `from`/`to` cannot address lines, or null; checked before the file arrives. */
export function snippetRangeError(from: number | null, to: number | null): string | null {
  for (const [name, line] of [["from", from], ["to", to]] as const) {
    if (line !== null && (!Number.isInteger(line) || line < 1)) return `\`${name}\` must be a line number (1 or more), got ${line}`;
  }
  if (from !== null && to !== null && from > to) return `\`from\` (${from}) is after \`to\` (${to})`;
  return null;
}

/**
 * Lines `from`..`to` of `text` (1-based, inclusive). `from` defaults to 1 and
 * `to` to the last line; `to` is clamped to the file, and at most
 * MAX_SNIPPET_LINES lines are returned.
 */
export function snippetLines(text: string, from: number | null, to: number | null): SnippetLines {
  const rangeError = snippetRangeError(from, to);
  if (rangeError !== null) return { code: null, error: rangeError };
  const lines = text.split(/\r?\n/);
  // A final newline ends the last line; it does not start another.
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { code: null, error: "the file is empty" };
  const start = from ?? 1;
  if (start > lines.length) {
    return { code: null, error: `the file has ${lines.length} line${lines.length === 1 ? "" : "s"}; \`from\` is ${start}` };
  }
  const end = Math.min(to ?? lines.length, lines.length, start + MAX_SNIPPET_LINES - 1);
  return { code: lines.slice(start - 1, end).join("\n"), error: null };
}
