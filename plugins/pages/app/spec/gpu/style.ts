export const PALETTE = ["var(--bb-chart-1, var(--primary))", "var(--bb-chart-2, var(--muted-foreground))", "var(--bb-chart-3, var(--success))", "var(--bb-chart-4, var(--warning))", "var(--bb-chart-5, var(--destructive))", "color-mix(in oklch, var(--primary) 50%, var(--background))"] as const;
export const TOOLTIP = "pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md";
export const NO_BB_SWIPE = { "data-no-sidebar-swipe": "", "data-no-secondary-panel-swipe": "" } as const;
export const cn = (...values: (string | boolean | null | undefined)[]): string => values.filter(Boolean).join(" ");
