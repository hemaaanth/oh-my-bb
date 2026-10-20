// The usage summary (SPEC §13.4): per day minutes and estimated cost.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { LIVE_USD_PER_MINUTE, USAGE_DAYS } from "../../shared/constants.js";
import type { RpcContract, UsageReport } from "../../shared/contract.js";
import { errorText, useLatest } from "../settings/data.js";
import { Loading, Note } from "../settings/layout.js";
import { formatMinutes, formatUsd } from "./format.js";

export const USAGE_NOTE = `GPT-Live voice at $${LIVE_USD_PER_MINUTE.toFixed(2)} per minute. Reasoning model tokens are billed separately by OpenAI and are not counted here.`;

export function UsageSummary({ reloadKey }: { reloadKey: unknown }) {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    rpcRef.current
      .call("usageReport", { days: USAGE_DAYS.default })
      .then((value) => active && setReport(value))
      .catch((cause: unknown) => active && setError(errorText(cause)));
    return () => {
      active = false;
    };
  }, [rpcRef, reloadKey]);

  if (!report) return <Loading error={error} />;

  return (
    <section aria-label="Usage" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-foreground">Usage, last {report.days} days</h3>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Day</th>
            <th className="py-1 text-right font-normal">Calls</th>
            <th className="py-1 text-right font-normal">Minutes</th>
            <th className="py-1 text-right font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {report.perDay.map((day) => (
            <tr key={day.day}>
              <td className="py-1 text-foreground">{day.day}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{day.calls}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{formatMinutes(day.seconds)}</td>
              <td className="py-1 text-right tabular-nums text-foreground">{formatUsd(day.usd)}</td>
            </tr>
          ))}
          {report.legacyTokenRows > 0 ? (
            <tr>
              <td colSpan={4} className="py-1 text-muted-foreground">
                {report.legacyTokenRows} older token-based usage {report.legacyTokenRows === 1 ? "row was" : "rows were"} imported. They are kept but not priced here.
              </td>
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <th scope="row" className="py-1 text-left font-medium text-foreground">
              Total
            </th>
            <td className="py-1 text-right tabular-nums text-muted-foreground">{report.perDay.reduce((sum, day) => sum + day.calls, 0)}</td>
            <td className="py-1 text-right tabular-nums text-foreground">{formatMinutes(report.totalSeconds)}</td>
            <td className="py-1 text-right tabular-nums text-foreground">{formatUsd(report.totalUsd)}</td>
          </tr>
        </tfoot>
      </table>
      <Note>{USAGE_NOTE}</Note>
    </section>
  );
}
