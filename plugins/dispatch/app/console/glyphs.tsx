// Small inline drawings for the console. They carry no meaning alone, so each
// one is hidden from assistive technology and sits next to a text label.
import type { ActionStatus } from "./trace.js";

const base = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export function PhoneGlyph() {
  return (
    <svg {...base} className="shrink-0">
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.5" />
      <path d="M7 12.5h2" />
    </svg>
  );
}

export function DesktopGlyph() {
  return (
    <svg {...base} className="shrink-0">
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5" />
      <path d="M5.5 14h5M8 11v3" />
    </svg>
  );
}

/** Running is a hollow ring, ok a tick, error a cross. */
export function StatusGlyph({ status }: { status: ActionStatus }) {
  const label = status === "running" ? "Running" : status === "ok" ? "Done" : "Failed";
  return (
    <span role="img" aria-label={label} title={label} className={status === "error" ? "text-destructive" : "text-muted-foreground"}>
      <svg {...base} aria-hidden="true">
        {status === "running" ? <circle cx="8" cy="8" r="5" strokeDasharray="3 3" /> : status === "ok" ? <path d="M3.5 8.5l3 3 6-7" /> : <path d="M4 4l8 8M12 4l-8 8" />}
      </svg>
    </span>
  );
}
