// One usage request feeds compact totals and the optional daily breakdown.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { LIVE_USD_PER_MINUTE, USAGE_DAYS } from "../../shared/constants.js";
import type { RpcContract, UsageReport } from "../../shared/contract.js";
import { errorText, useLatest } from "../settings/data.js";
import { Loading, Note } from "../settings/layout.js";
import { dayKey, formatMinutes, formatUsd } from "./format.js";

export const USAGE_NOTE = `GPT-Live voice at $${LIVE_USD_PER_MINUTE.toFixed(2)} per minute. Reasoning model tokens are billed separately by OpenAI and are not counted here.`;

export function usageTotals(report: UsageReport, now = Date.now()) {
  const first = new Date(now);
  first.setDate(first.getDate() - 6);
  const todayKey = dayKey(now);
  const firstKey = dayKey(first.getTime());
  const sum = (days: UsageReport["perDay"]) => days.reduce((total, day) => ({ seconds: total.seconds + day.seconds, usd: total.usd + day.usd }), { seconds: 0, usd: 0 });
  return [
    { label: "Today", ...sum(report.perDay.filter((day) => day.day === todayKey)) },
    { label: "Last 7 days", ...sum(report.perDay.filter((day) => day.day >= firstKey && day.day <= todayKey)) },
    { label: `Last ${report.days} days`, seconds: report.totalSeconds, usd: report.totalUsd },
  ];
}

export function UsageSummary({ reloadKey }: { reloadKey: unknown }) {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    rpcRef.current.call("usageReport", { days: USAGE_DAYS.default }).then((value) => {
      if (active) { setReport(value); setError(null); }
    }).catch((cause: unknown) => active && setError(errorText(cause)));
    return () => { active = false; };
  }, [rpcRef, reloadKey]);

  if (!report) return <section aria-label="Usage" className="min-h-32"><Loading error={error} /></section>;

  return (
    <section aria-label="Usage" className="min-h-32 space-y-2">
      <dl className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-md border border-border bg-surface-raised">
        {usageTotals(report).map((total) => <div key={total.label} className="min-w-0 px-3 py-3 sm:px-4">
          <dt className="text-xs text-muted-foreground">{total.label}</dt>
          <dd className="mt-1 text-base font-medium tabular-nums text-foreground sm:text-lg">{formatMinutes(total.seconds)}</dd>
          <dd className="mt-0.5 text-xs tabular-nums text-muted-foreground">{formatUsd(total.usd)}</dd>
        </div>)}
      </dl>
      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer py-1 hover:text-foreground">Daily usage & pricing</summary>
        <div className="mt-2 space-y-3 rounded-md border border-border p-3">
          <h2 className="text-xs font-medium text-foreground">Usage, last {report.days} days</h2>
          <table className="w-full border-collapse text-xs">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 font-normal">Day</th>
                <th scope="col" className="py-2 text-right font-normal">Calls</th>
                <th scope="col" className="py-2 text-right font-normal">Minutes</th>
                <th scope="col" className="py-2 text-right font-normal">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {report.perDay.map((day) => <tr key={day.day}>
                <td className="py-2 text-foreground">{day.day}</td>
                <td className="py-2 text-right tabular-nums">{day.calls}</td>
                <td className="py-2 text-right tabular-nums">{formatMinutes(day.seconds)}</td>
                <td className="py-2 text-right tabular-nums text-foreground">{formatUsd(day.usd)}</td>
              </tr>)}
            </tbody>
            <tfoot className="border-t border-border">
              <tr>
                <th scope="row" className="py-2 text-left font-medium text-foreground">Total</th>
                <td className="py-2 text-right tabular-nums">{report.perDay.reduce((sum, day) => sum + day.calls, 0)}</td>
                <td className="py-2 text-right tabular-nums text-foreground">{formatMinutes(report.totalSeconds)}</td>
                <td className="py-2 text-right tabular-nums text-foreground">{formatUsd(report.totalUsd)}</td>
              </tr>
            </tfoot>
          </table>
          <Note>{USAGE_NOTE}</Note>
        </div>
      </details>
      {error ? <Note tone="error">{error}</Note> : null}
    </section>
  );
}
