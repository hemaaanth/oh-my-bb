// The transcript of one call (SPEC §13.3). It loads the saved events once and
// then appends whatever arrives on `trace-tail`. It never fetches again for a live call.
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useState } from "react";
import { CHANNELS } from "../../shared/constants.js";
import type { CallRow, RpcContract, TraceRow, TraceTailPayload } from "../../shared/contract.js";
import { Button } from "../components/ui/button";
import { privateCallText } from "../phone-status.js";
import { errorText, useLatest } from "../settings/data.js";
import { Loading, Note } from "../settings/layout.js";
import { FilterChips } from "./calls-list.js";
import { formatDateTime } from "./format.js";
import { useEscape } from "./keys.js";
import { TranscriptRow } from "./transcript-rows.js";
import { filterItems, groupTrace, mergeRows, type TraceFilter } from "./trace.js";

const CHIPS: ReadonlyArray<{ id: TraceFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "talk", label: "Talk" },
  { id: "actions", label: "Actions" },
  { id: "errors", label: "Errors" },
];

/** The call's summary, and the button that deletes what Dispatch remembers of it. */
function CallMemory({ call, forgotten, onForget }: { call: CallRow | null; forgotten: boolean; onForget: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const summary = call?.summary && call.summary.status !== "skipped" && !forgotten ? call.summary : null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
      {summary ? (
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{privateCallText(summary.title)}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{privateCallText(summary.summary)}</p>
        </div>
      ) : (
        <Note>{forgotten ? "Dispatch does not remember this call. Its transcript and summary are deleted." : "No summary for this call."}</Note>
      )}
      {forgotten ? null : confirming ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onForget().finally(() => {
                setBusy(false);
                setConfirming(false);
              });
            }}
          >
            Delete transcript and summary
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Forget this call
          </Button>
        </div>
      )}
    </div>
  );
}

export function Transcript({ callId, call, agentName, onClose }: { callId: string; call: CallRow | null; agentName: string; onClose: () => void }) {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<TraceFilter>("all");
  const [forgotten, setForgotten] = useState(call?.forgotten ?? false);

  useEscape(true, onClose);

  useEffect(() => {
    let active = true;
    setRows([]);
    setCursor(null);
    setLoaded(false);
    setError(null);
    rpcRef.current
      .call("callTrace", { callId })
      .then((page) => {
        if (!active) return;
        // Tail events that arrived during the fetch stay: merge, never replace.
        setRows((current) => mergeRows(current, page.events));
        setCursor(page.nextCursor);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(errorText(cause));
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [callId, rpcRef]);

  useRealtime(CHANNELS.traceTail, (payload) => {
    const tail = payload as TraceTailPayload;
    if (tail.callId === callId) setRows((current) => mergeRows(current, tail.events));
  });

  // Works during a live call too: speech that arrives later is not stored.
  const forget = async () => {
    try {
      await rpcRef.current.call("forgetCall", { callId });
      setForgotten(true);
      setRows((current) => current.filter((row) => !row.kind.startsWith("speech.")));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await rpcRef.current.call("callTrace", { callId, cursor });
      setRows((current) => mergeRows(current, page.events));
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const items = useMemo(() => groupTrace(rows), [rows]);
  const shown = useMemo(() => filterItems(items, filter), [items, filter]);

  return (
    <section aria-label="Transcript" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Back to calls
          </Button>
          <span className="text-sm text-muted-foreground">{call ? `${privateCallText(call.device.label || "Call")} · ${formatDateTime(call.startedAt)}` : "Call"}</span>
        </div>
        <FilterChips label="Filter transcript" chips={CHIPS} value={filter} onChange={setFilter} />
      </div>
      <CallMemory call={call} forgotten={forgotten} onForget={forget} />
      {!loaded ? <Loading error={error ? privateCallText(error) : null} /> : null}
      {loaded && shown.length === 0 && !error ? <Note>{rows.length === 0 ? "Nothing was recorded for this call yet." : "Nothing matches this filter."}</Note> : null}
      <ul className="flex flex-col">
        {shown.map((item) => (
          <TranscriptRow key={`${item.type}-${item.id}`} item={item} agentName={agentName} />
        ))}
      </ul>
      {loaded && error ? <Note tone="error">{privateCallText(error)}</Note> : null}
      {cursor ? (
        <div>
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            Load more events
          </Button>
        </div>
      ) : null}
    </section>
  );
}
