// Pure helpers for the Project group: times, test reports, and the JSON viewer.

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** ISO text or epoch ms as a time, or null. */
export function timeOf(value: unknown): number | null {
  const at = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

// Ported from GenUI core/project.ts relativeTime (Apache-2.0).
export function relativeTime(value: unknown, now = Date.now()): string {
  const at = timeOf(value);
  if (at === null) return "";
  const elapsed = now - at;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 2 * DAY) return "yesterday";
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;
  const date = new Date(at);
  return date.toLocaleDateString(undefined, date.getFullYear() === new Date(now).getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export type TestStatus = "passed" | "failed" | "skipped";
export type TestCase = { name: string; status: TestStatus; suite?: string; file?: string; ms?: number; message?: string };

// Ported from GenUI core/test-results.ts STATUS_WORDS (Apache-2.0).
const WORDS: Record<string, TestStatus> = {
  pass: "passed", passed: "passed", ok: "passed", success: "passed", focused: "passed",
  fail: "failed", failed: "failed", failing: "failed", failure: "failed", error: "failed", errored: "failed", broken: "failed", crashed: "failed", timedout: "failed", timeout: "failed",
  skip: "skipped", skipped: "skipped", pending: "skipped", todo: "skipped", disabled: "skipped", ignored: "skipped", excluded: "skipped", xfail: "skipped", xfailed: "skipped",
};

export function testStatus(value: unknown): TestStatus | null {
  if (typeof value === "boolean") return value ? "passed" : "failed";
  if (typeof value !== "string") return null;
  return WORDS[value.trim().toLowerCase().replace(/[\s_-]+/gu, "")] ?? null;
}

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const errorText = (value: unknown): string | undefined => Array.isArray(value) ? text(value.map(errorText).filter(Boolean).join("\n\n")) : text(value) ?? text(record(value)?.stack) ?? text(record(value)?.message);

function listTest(value: unknown, suite?: string, file?: string): TestCase | null {
  const item = record(value);
  const name = item && (text(item.name) ?? text(item.title) ?? text(item.fullName));
  const status = item && testStatus(item.status ?? item.state ?? item.outcome ?? item.result ?? item.passed);
  if (!item || !name || !status) return null;
  return { name, status, suite: text(item.suite) ?? text(item.classname) ?? suite, file: text(item.file) ?? file, ms: number(item.ms) ?? number(item.duration), message: errorText(item.message) ?? errorText(item.error) ?? errorText(item.failureMessages) };
}

/**
 * Test cases from what a runner writes: a list of cases (or of `{suite, tests}` groups), vitest's or jest's
 * JSON report (`testResults[].assertionResults[]`), or JUnit XML text. Anything else gives no cases.
 */
export function readTests(input: unknown): TestCase[] {
  if (typeof input === "string") return input.trimStart().startsWith("<") ? readJUnit(input) : [];
  if (Array.isArray(input)) return input.flatMap((item) => {
    const group = record(item);
    if (group && Array.isArray(group.tests)) return group.tests.map((test) => listTest(test, text(group.suite) ?? text(group.name), text(group.file))).filter((test): test is TestCase => test !== null);
    const test = listTest(item);
    return test ? [test] : [];
  });
  const report = record(input);
  if (!report) return [];
  if (Array.isArray(report.tests)) return readTests(report.tests);
  if (!Array.isArray(report.testResults)) return [];
  return report.testResults.flatMap((entry) => {
    const result = record(entry);
    const file = text(result?.name) ?? text(result?.testFilePath);
    return (Array.isArray(result?.assertionResults) ? result.assertionResults : []).flatMap((value) => {
      const assertion = record(value);
      const status = testStatus(assertion?.status);
      const name = text(assertion?.title) ?? text(assertion?.fullName);
      if (!assertion || !status || !name) return [];
      const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles.filter((title): title is string => typeof title === "string" && title !== "") : [];
      return [{ name, status, suite: ancestors.join(" › ") || undefined, file, ms: number(assertion.duration), message: errorText(assertion.failureMessages) }];
    });
  });
}

/** JUnit XML to cases. The browser's XML parser does the reading; a parse error gives no cases. */
export function readJUnit(xml: string): TestCase[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return [];
  return Array.from(doc.getElementsByTagName("testcase"), (node) => {
    const suite = node.getAttribute("classname") || (node.parentElement?.tagName === "testsuite" ? node.parentElement.getAttribute("name") : null) || undefined;
    const problem = Array.from(node.children).find((child) => child.tagName === "failure" || child.tagName === "error");
    const skipped = Array.from(node.children).find((child) => child.tagName === "skipped");
    const seconds = Number(node.getAttribute("time"));
    const detail = problem ?? skipped;
    const body = detail?.textContent?.trim();
    const message = detail ? (body || detail.getAttribute("message") || undefined) : undefined;
    return { name: node.getAttribute("name") || "(unnamed test)", status: problem ? "failed" : skipped ? "skipped" : "passed", suite, file: node.getAttribute("file") || undefined, ms: node.hasAttribute("time") && Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined, message };
  });
}

export function testCounts(cases: readonly TestCase[]): Record<TestStatus, number> {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const test of cases) counts[test.status]++;
  return counts;
}

/** Cases by suite, failures first within each, suites with failures first. */
export function groupTests(cases: readonly TestCase[]): { suite: string; cases: TestCase[]; failed: number }[] {
  const order: Record<TestStatus, number> = { failed: 0, skipped: 1, passed: 2 };
  const groups = new Map<string, TestCase[]>();
  for (const test of cases) {
    const key = test.suite ?? test.file ?? "";
    groups.set(key, [...(groups.get(key) ?? []), test]);
  }
  return [...groups].map(([suite, list]) => ({ suite, cases: [...list].sort((a, b) => order[a.status] - order[b.status]), failed: list.filter((test) => test.status === "failed").length }))
    .sort((a, b) => Number(b.failed > 0) - Number(a.failed > 0));
}

export function formatMs(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** A one-line preview of a JSON value for a closed node: `{3 keys}`, `[12 items]`, or the scalar. */
export function jsonPreview(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
  if (value && typeof value === "object") { const n = Object.keys(value).length; return `{${n} ${n === 1 ? "key" : "keys"}}`; }
  return jsonScalar(value);
}

export function jsonScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  return String(value);
}

/** The children of a JSON node as [key, value] pairs; none for scalars. */
export function jsonChildren(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}
