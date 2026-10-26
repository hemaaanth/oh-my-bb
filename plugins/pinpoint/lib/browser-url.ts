const MARKDOWN_LINK_DESTINATION = /\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/i;
const PLAIN_HTTP_URL = /https?:\/\/[^\s<>"'()[\]{}]+/i;

/** Return the first complete HTTP(S) URL without consuming Markdown syntax. */
export function firstViewableUrl(text: string): string | null {
  const markdown = text.match(MARKDOWN_LINK_DESTINATION)?.[1];
  const candidate = markdown ?? text.match(PLAIN_HTTP_URL)?.[0];
  if (!candidate) return null;
  const trimmed = candidate.replace(/[.,;:!?]+$/, "");
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

/** Accept an address-bar value or pasted Markdown link and produce a browser URL. */
export function normalizeBrowserUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = firstViewableUrl(trimmed) ?? trimmed;
  const scheme = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(
    candidate,
  )
    ? "http"
    : "https";
  const next = /^https?:\/\//i.test(candidate)
    ? candidate
    : `${scheme}://${candidate}`;
  try {
    const parsed = new URL(next);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Annotation scope follows an actual page route. Normal section hashes remain
 * on that page, while query-string routes are distinct.
 */
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return (
      x.origin === y.origin &&
      x.pathname === y.pathname &&
      x.search === y.search
    );
  } catch {
    return a === b;
  }
}

