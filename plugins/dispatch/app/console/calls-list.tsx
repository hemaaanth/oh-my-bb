// The paged calls list (SPEC §13.2). The filter chips work on the pages already loaded.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { CALLS_PAGE, LIVE_USD_PER_MINUTE } from "../../shared/constants.js";
import type { CallChannel, CallRow, RpcContract } from "../../shared/contract.js";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { errorText, useLatest } from "../settings/data.js";
import { Loading, Note } from "../settings/layout.js";
import { formatDateTime, formatElapsed, formatMinutes, formatUsd } from "./format.js";
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

export function CallsList({ calls, error, hasMore, loadMore, loadingMore, onOpen }: ReturnType<typeof useCalls> & { onOpen: (call: CallRow) => void }) {
  const [chip, setChip] = useState<Chip>("all");
  if (!calls) return <Loading error={error} />;
  const shown = chip === "all" ? calls : calls.filter((call) => call.channel === chip);

  return (
    <section aria-label="Calls" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Calls</h3>
        <FilterChips label="Filter calls" chips={CHIPS} value={chip} onChange={setChip} />
      </div>
      {shown.length === 0 ? <Note>{calls.length === 0 ? "No calls yet." : "No calls match this filter."}</Note> : null}
      <ul className="flex flex-col">
        {shown.map((call) => (
          <li key={call.id}>
            <button type="button" onClick={() => onOpen(call)} className={cn("flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}>
              {call.channel === "phone" || call.device.mobile ? <PhoneGlyph /> : <DesktopGlyph />}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-foreground">{call.device.label || "Unknown device"}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(call.startedAt)}</span>
              </span>
              <Badge variant="outline">{call.channel}</Badge>
              {call.unclean ? <Badge variant="secondary">unclean</Badge> : null}
              <span className="w-14 text-right tabular-nums text-muted-foreground">{call.endedAt === null ? (call.unclean ? "—" : "Live") : formatElapsed((call.endedAt - call.startedAt) / 1000)}</span>
              <span className="w-16 text-right tabular-nums text-muted-foreground">{formatMinutes(call.billedSeconds)}</span>
              <span className="w-16 text-right tabular-nums text-foreground">{formatUsd((call.billedSeconds / 60) * LIVE_USD_PER_MINUTE)}</span>
            </button>
          </li>
        ))}
      </ul>
      {error ? <Note tone="error">{error}</Note> : null}
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
