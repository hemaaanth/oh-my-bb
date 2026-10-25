import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { IntelligenceStatus, rpcContract } from "./server";
import { Button } from "@/components/ui/button";

import { PREFERENCES_CHANGED } from "./shared";
type Status = Pick<IntelligenceStatus, "configured" | "enabled" | "backend" | "model" | "reason" | "automaticBriefs">;

/** Tests the saved backend only on an explicit click. Readiness uses no model call. */
export function AiSettingsSection({ disabled = false }: { disabled?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings();
  const [status, setStatus] = useState<Status | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // Each settings change starts a new generation; a slow answer from an older one is dropped.
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    rpc.call("journal_intelligence_status", null).then((next) => { if (current === generation.current) setStatus(next); }, (cause: unknown) => {
      if (current === generation.current) setStatus({ configured: false, enabled: false, backend: "openrouter", model: "", reason: cause instanceof Error ? cause.message : String(cause), automaticBriefs: false });
    });
  }, [rpc]);
  // Settings edits change the backend; re-read status after each and forget an old Test result.
  const refresh = useCallback(() => { setTest(null); setTesting(false); load(); }, [load]);
  useEffect(() => { refresh(); return () => { generation.current++; }; }, [refresh, settings.values]);
  useRealtime(PREFERENCES_CHANGED, refresh);
  const runTest = () => {
    setTesting(true); setTest(null);
    const current = generation.current;
    rpc.call("journal_ai_test", null).then(
      (result) => { if (current === generation.current) setTest(result); },
      (cause: unknown) => { if (current === generation.current) setTest({ ok: false, message: cause instanceof Error ? cause.message : String(cause) }); },
    ).finally(() => { if (current === generation.current) { setTesting(false); load(); } });
  };
  return <div className="space-y-2 text-xs text-muted-foreground">
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled || testing || !status?.enabled} onClick={runTest}>{testing ? "Testing…" : "Test"}</Button>
      <span>{disabled ? "Save changes before testing." : status?.backend === "subscription" ? "Uses your selected subscription account." : "Tests saved settings. OpenRouter charges may apply."}</span>
      {test && <span role="status" className={test.ok ? "" : "text-destructive"}>{test.ok ? "Answered." : test.message}</span>}
    </div>
    <details>
      <summary className="w-fit cursor-pointer">Backend details</summary>
      <p role="status" className="mt-2">
        {!status ? "Checking…" : `${status.backend === "subscription" ? "ChatGPT subscription via Model Gateway" : "OpenRouter"} · ${status.model} · `}
        {status && (!status.enabled ? "summaries off" : status.configured ? "ready" : `not ready${status.reason ? `: ${status.reason}` : ""}`)}
      </p>
      {status && <p className="mt-1">{status.automaticBriefs ? "Automatic thread briefings are on. Subscription calls have no dollar charge here; the daily call limit still applies." : "Automatic thread briefings run only with the subscription backend."}</p>}
    </details>
  </div>;
}
