import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";

export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Portaled overlays land in document.body, outside the plugin mount. The plugin stylesheet is scoped
 * to `[data-bb-plugin="pages"]`, so each portaled root carries the scope itself.
 */
export const PORTAL_SCOPE = { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", "data-bb-plugin": "pages" } as const;

/** The BB app's resolved light/dark mode. Code themes follow it the moment the user switches. */
export function usePreviewTheme(): "light" | "dark" {
  return experimental_useCodeTheme().mode;
}

/** The page background, `--bb-bg` in assets/theme.css for a `body.auto` page. The panel chrome uses it so header and page read as one surface. */
export const PAGE_BG = { light: "#f9fafb", dark: "#09090b" } as const;

/** Preview routes take `&theme=light|dark`, which sets `data-bb-theme` for pages that follow the app. */
export function themedUrl(url: string, theme: "light" | "dark", frame?: "card"): string {
  return `${url}${url.includes("?") ? "&" : "?"}theme=${theme}${frame ? `&frame=${frame}` : ""}`;
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000;
  if (!Number.isFinite(seconds)) return "";
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return "just now";
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SharedDot() {
  return <span role="img" aria-label="Shared" title="Shared" className="size-1.5 shrink-0 rounded-full bg-success" />;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: string; iconClassName?: string };
/** A 24px icon button. The label is both the accessible name and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, icon, iconClassName = "size-3.5", className = "", ...props }, ref) {
  return <button ref={ref} type="button" aria-label={label} title={label} className={`inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground ${focusRing} ${className}`} {...props}>
    <Icon name={icon} aria-hidden className={iconClassName} />
  </button>;
});

/** One quiet status line inside the card frame. */
export function QuietLine({ tone = "muted", source, children }: { tone?: "muted" | "error"; source?: string; children: ReactNode }) {
  return <div role={tone === "error" ? "alert" : "status"} className="my-2 flex min-h-8 min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
    <span className={tone === "error" ? "shrink-0 text-destructive" : "min-w-0 truncate"}>{children}</span>
    {source ? <code className="min-w-0 truncate font-mono opacity-70" title={source}>{source}</code> : null}
  </div>;
}
