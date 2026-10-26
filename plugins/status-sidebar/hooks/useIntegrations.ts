import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { IntegrationPatch, IntegrationView } from "../integrations";
import { INTEGRATIONS_CHANGED_CHANNEL } from "../shared";

export function useIntegrations() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<IntegrationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const request = useRef(0);
  const load = useCallback(() => {
    const id = ++request.current;
    void rpc.call("getIntegrations", null).then((next) => {
      if (id === request.current) { setData(next); setError(null); }
    }, (cause: unknown) => {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc]);
  useEffect(() => { load(); return () => { request.current += 1; }; }, [load]);
  useRealtime(INTEGRATIONS_CHANGED_CHANNEL, load);
  const save = async (patch: IntegrationPatch) => {
    const id = ++request.current;
    setSaving(true);
    setError(null);
    try {
      const next = await rpc.call("setIntegrations", patch);
      if (id === request.current) setData(next);
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };
  return { data, error, saving, load, save };
}
