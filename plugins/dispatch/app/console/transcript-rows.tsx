// One transcript row per item (SPEC §13.3).
import { useState, type ReactNode } from "react";
import { formatClock } from "./format.js";
import { StatusGlyph } from "./glyphs.js";
import { clip, type TraceItem } from "./trace.js";

const Time = ({ at }: { at: number }) => <time className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground">{formatClock(at)}</time>;

function Expandable({ summary, children, label }: { summary: ReactNode; children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <button type="button" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${label}`} onClick={() => setOpen(!open)} className="flex items-center gap-2 text-left text-sm text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {summary}
      </button>
      {open ? children : null}
    </div>
  );
}

const Block = ({ title, body }: { title: string; body: string }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-xs text-muted-foreground">{title}</span>
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-state-hover p-2 text-xs text-foreground">{clip(body)}</pre>
  </div>
);

const pretty = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
};

export function TranscriptRow({ item, agentName }: { item: TraceItem; agentName: string }) {
  switch (item.type) {
    case "speech":
      return (
        <li className="flex items-start gap-3 py-1.5">
          <Time at={item.at} />
          <div className="min-w-0 flex-1">
            <span className="text-xs font-medium text-muted-foreground">{item.who === "user" ? "You" : agentName}</span>
            <p className="whitespace-pre-wrap text-sm text-foreground">{item.text}</p>
          </div>
        </li>
      );
    case "action": {
      const hasDetail = item.args !== null || item.output !== null;
      return (
        <li className="flex items-start gap-3 py-1.5">
          <Time at={item.at} />
          {hasDetail ? (
            <Expandable
              label={`details of ${item.title}`}
              summary={
                <>
                  <StatusGlyph status={item.status} />
                  <span className="min-w-0 truncate">{item.title}</span>
                </>
              }
            >
              {item.args !== null ? <Block title="Arguments" body={pretty(item.args)} /> : null}
              {item.output !== null ? <Block title="Result" body={item.output} /> : null}
            </Expandable>
          ) : (
            <span className="flex items-center gap-2 text-sm text-foreground">
              <StatusGlyph status={item.status} />
              {item.title}
            </span>
          )}
        </li>
      );
    }
    case "notice":
      return (
        <li className="flex items-start gap-3 py-1.5">
          <Time at={item.at} />
          <p className="text-sm italic text-muted-foreground">{item.text}</p>
        </li>
      );
    case "error":
      return (
        <li className="flex items-start gap-3 py-1.5">
          <Time at={item.at} />
          <p role="alert" className="text-sm text-destructive">
            {item.text}
          </p>
        </li>
      );
    case "system": {
      const count = item.events.length === 1 ? "1 system event" : `${item.events.length} system events`;
      return (
        <li className="flex items-start gap-3 py-1.5">
          <Time at={item.at} />
          <Expandable label={count} summary={<span className="text-muted-foreground">{count}</span>}>
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {item.events.map((event) => (
                <li key={event.id} className="flex gap-2">
                  <span className="tabular-nums">{formatClock(event.at)}</span>
                  <code>{event.kind}</code>
                  {event.payload ? <span className="min-w-0 truncate">{clip(JSON.stringify(event.payload), 120)}</span> : null}
                </li>
              ))}
            </ul>
          </Expandable>
        </li>
      );
    }
  }
}
