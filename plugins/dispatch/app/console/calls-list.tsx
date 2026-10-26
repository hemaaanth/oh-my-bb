// The paged calls list (SPEC §13.2). The filter chips work on the pages already loaded.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { CALLS_PAGE, LIVE_USD_PER_MINUTE } from "../../shared/constants.js";
import type { CallChannel, CallRow, RpcContract } from "../../shared/contract.js";
import { Button } from "../components/ui/button";
import { privateCallText } from "../phone-status.js";
import { errorText, useLatest } from "../settings/data.js";
import { Loading, Note } from "../settings/layout.js";
import { formatCallWhen, formatDateTime, formatElapsed, formatUsd } from "./format.js";
import type { CallState } from "./presence.js";
import { DesktopGlyph, PhoneGlyph } from "./glyphs.js";

type Chip = "all" | CallChannel;
const CHIPS: ReadonlyArray<{ id: Chip; label: string }> = [
  { id: "all", label: "All" },
  { id: "app", label: "App" },
  { id: "phone", label: "Phone" },
];

export function FilterChips<T extends string>({ label, chips, value, onChange }: { label: string; chips: ReadonlyArray<{ id: T; label: string }>; value: T; onChange: (id: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex gap-1.5">
      {chips.map((chip) => (
        <Button key={chip.id} variant={chip.id === value ? "secondary" : "ghost"} size="sm" aria-pressed={chip.id === value} onClick={() => onChange(chip.id)}>
          {chip.label}
        </Button>
      ))}
    </div>
  );
}

/** Loads the calls and exposes the loaded rows. `reloadKey` starts a fresh load. */
export function useCalls(reloadKey: unknown) {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let active = true;
    rpcRef.current
      .call("callsPage", { limit: CALLS_PAGE.default })
      .then((page) => {
        if (!active) return;
        setCalls(page.calls);
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((cause: unknown) => active && setError(errorText(cause)));
    return () => {
      active = false;
    };
  }, [rpcRef, reloadKey]);

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await rpcRef.current.call("callsPage", { cursor, limit: CALLS_PAGE.default });
      setCalls((current) => [...(current ?? []), ...page.calls.filter((row) => !current?.some((known) => known.id === row.id))]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setMore(false);
    }
  };

  return { calls, error, hasMore: cursor !== null, loadMore, loadingMore: more };
}

/** What the row says about the call's memory: its summary title, or that it is forgotten. */
export function memoryLine(call: CallRow): { line: string; full: string } | null {
  if (call.forgotten) return { line: "Not remembered", full: "You asked Dispatch not to remember this call." };
  const summary = call.summary;
  if (!summary || summary.status === "skipped") return null;
  return { line: privateCallText(summary.title), full: privateCallText(summary.summary) };
}

export function CallsList({ calls, error, hasMore, loadMore, loadingMore, onOpen, live }: ReturnType<typeof useCalls> & { onOpen: (call: CallRow) => void; live: CallState }) {
  const [chip, setChip] = useState<Chip>("all");
  if (!calls) return <Loading error={error ? privateCallText(error) : null} />;
  const shown = chip === "all" ? calls : calls.filter((call) => call.channel === chip);

  return (
    <section aria-label="Calls" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Calls</h3>
        <FilterChips label="Filter calls" chips={CHIPS} value={chip} onChange={setChip} />
      </div>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead className="border-b border-border bg-surface-raised text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="hidden w-40 px-3 py-2 font-normal @min-[40rem]/dispatch:table-cell">When</th>
              <th scope="col" className="px-3 py-2 font-normal">Device</th>
              <th scope="col" className="w-16 px-2 py-2 text-right font-normal @min-[40rem]/dispatch:w-20 @min-[40rem]/dispatch:px-3">Duration</th>
              <th scope="col" className="w-16 px-2 py-2 text-right font-normal @min-[40rem]/dispatch:w-20 @min-[40rem]/dispatch:px-3">Cost</th>
              <th scope="col" className="hidden w-28 px-3 py-2 font-normal @min-[40rem]/dispatch:table-cell">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {shown.map((call) => {
              const isLive = live.live && call.endedAt === null && !call.unclean && call.startedAt === live.startedAt && call.channel === live.channel;
              const status = isLive ? "Live" : call.unclean ? "Unclean end" : call.endedAt === null ? "Not closed" : call.closeReason === "failed" ? "Failed" : "Ended";
              const duration = call.endedAt !== null ? formatElapsed((call.endedAt - call.startedAt) / 1000) : isLive ? formatElapsed((live.now - call.startedAt) / 1000) : "Not available";
              const cost = formatUsd((call.billedSeconds / 60) * LIVE_USD_PER_MINUTE);
              const label = privateCallText(call.device.label || "Unknown device");
              const when = formatCallWhen(call.startedAt, live.now);
              const memory = memoryLine(call);
              return <tr key={call.id} onClick={() => onOpen(call)} className="group cursor-pointer hover:bg-state-hover focus-within:bg-state-hover">
                <td className="hidden whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground @min-[40rem]/dispatch:table-cell"><time dateTime={new Date(call.startedAt).toISOString()} title={formatDateTime(call.startedAt)}>{when}</time></td>
                <td className="px-3 py-2">
                  <button type="button" aria-label={`${label}, ${when}, ${status}`} className="flex w-full min-w-0 items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                    <span className="mt-0.5 shrink-0 text-muted-foreground" aria-label={call.channel === "phone" ? "Phone call" : "In-app call"}>{call.channel === "phone" || call.device.mobile ? <PhoneGlyph /> : <DesktopGlyph />}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-foreground">{label}</span>
                      {memory ? <span title={memory.full} className="mt-0.5 block truncate text-xs text-muted-foreground">{memory.line}</span> : null}
                      <span className="mt-0.5 block text-xs text-muted-foreground @min-[40rem]/dispatch:hidden">{when}<span className="ml-1.5 text-subtle-foreground">· {status}</span></span>
                    </span>
                  </button>
                </td>
                <td title={duration} className="truncate px-2 py-2 text-right text-xs tabular-nums text-muted-foreground @min-[40rem]/dispatch:px-3">{duration}</td>
                <td title={cost} className="truncate px-2 py-2 text-right text-xs tabular-nums text-foreground @min-[40rem]/dispatch:px-3">{cost}</td>
                <td className="hidden px-3 py-2 text-xs text-subtle-foreground @min-[40rem]/dispatch:table-cell">{status}</td>
              </tr>;
            })}
          </tbody>
        </table>
        {shown.length === 0 ? <p className="px-3 py-5 text-sm text-muted-foreground">{calls.length === 0 ? "No calls yet. Wake your agent to start a conversation." : "No calls match this filter."}</p> : null}
      </div>
      {error ? <Note tone="error">{privateCallText(error)}</Note> : null}
      {hasMore ? (
        <div>
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
