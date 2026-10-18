// Pure logic for the Evidence group: the acceptance verdict, evidence shapes, the best cells of a comparison, and clock times.

export type AcceptanceStatus = "pass" | "fail" | "unknown";
export type AcceptanceItem = { criterion: string; status?: AcceptanceStatus; evidence?: string; note?: string };
export type Verdict = { headline: string; tone: "success" | "warning" | "danger" | "neutral"; line: string; counts: Record<AcceptanceStatus, number> };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// Ported from GenUI core/acceptance.ts (Apache-2.0). Honesty rule: a missing or unknown result is never a pass.
/** "Done" only when every criterion passed; "Not done" when any failed; else "Not proven". */
export function acceptanceVerdict(items: AcceptanceItem[]): Verdict {
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const item of items) counts[item.status === "pass" || item.status === "fail" ? item.status : "unknown"]++;
  const total = items.length;
  const parts = [counts.fail ? `${counts.fail} failing` : "", counts.unknown ? `${counts.unknown} unknown` : ""].filter(Boolean);
  if (total === 0) return { headline: "No criteria", tone: "neutral", line: "No criteria yet", counts };
  if (counts.pass === total) return { headline: "Done", tone: "success", line: `All ${plural(total, "criterion", "criteria")} pass`, counts };
  const line = [`${counts.pass} of ${plural(total, "criterion", "criteria")} pass`, ...parts].join(" · ");
  return counts.fail > 0 ? { headline: "Not done", tone: "danger", line, counts } : { headline: "Not proven", tone: "warning", line, counts };
}

export type EvidenceShape = { kind: "url" | "file" | "text"; text: string };

// Ported from GenUI core/acceptance.ts (Apache-2.0).
/** Evidence by its shape: an http(s) link, a file path (one token with a path prefix or an extension, `path:12` too), else text. */
export function evidenceShape(raw: string): EvidenceShape {
  const text = raw.trim();
  if (/^https?:\/\/\S+$/iu.test(text)) return { kind: "url", text };
  if (/\s/u.test(text)) return { kind: "text", text };
  if (/^(\/|\.{1,2}\/|~\/)/u.test(text)) return { kind: "file", text };
  const path = text.replace(/(#L\d+(-L?\d+)?|:\d+(:\d+|-\d+)?)$/u, "");
  return /\.[A-Za-z]\w{0,9}$/u.test(path) && /[A-Za-z]/u.test(path.replace(/\.[^.]*$/u, "")) ? { kind: "file", text } : { kind: "text", text };
}

export type CompareCell = string | number | null | undefined;
export type CompareRow = { criterion: string; values?: CompareCell[]; better?: "high" | "low" };

/** A cell as a number: a number, or text that starts with one ("$12", "1,200 ms", "4.5"). */
export function cellNumber(cell: CompareCell): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  const match = typeof cell === "string" ? /^\s*[$€£¥]?\s*(-?\d[\d,]*(?:\.\d+)?)/u.exec(cell) : null;
  return match ? Number(match[1]!.replace(/,/gu, "")) : null;
}

/**
 * Which cells win their row and how many rows each option wins. A row with `better` and at least two numbers
 * has a best: the highest or lowest. A row where every number ties has none. The leader wins the most rows, alone.
 */
export function compareBest(optionCount: number, rows: CompareRow[]): { best: boolean[][]; wins: number[]; leader: number | null } {
  const wins = Array.from({ length: optionCount }, () => 0);
  const best = rows.map((row) => {
    const values = Array.from({ length: optionCount }, (_, index) => cellNumber(row.values?.[index]));
    const numbers = values.filter((value): value is number => value !== null);
    if (!row.better || numbers.length < 2) return values.map(() => false);
    const top = row.better === "high" ? Math.max(...numbers) : Math.min(...numbers);
    if (numbers.every((value) => value === top)) return values.map(() => false);
    return values.map((value, index) => {
      if (value !== top) return false;
      wins[index]!++;
      return true;
    });
  });
  const most = Math.max(0, ...wins);
  const leaders = wins.flatMap((count, index) => (count === most ? [index] : []));
  return { best, wins, leader: most > 0 && leaders.length === 1 ? leaders[0]! : null };
}

// Ported from GenUI core/transcript.ts (Apache-2.0).
/** Seconds as m:ss, or h:mm:ss past an hour. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const [hours, minutes, secs] = [Math.floor(safe / 3600), Math.floor((safe % 3600) / 60), String(safe % 60).padStart(2, "0")];
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}
