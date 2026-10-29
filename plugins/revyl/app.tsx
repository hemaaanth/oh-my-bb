import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbContext, useBbNavigate, useRealtime, useRpc, type ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { rpcContract, THREAD_CHANGED, type Platform } from "./contract.js";

type Embeds = Record<Platform, string | null>;

function DevicePanel({ threadId, params }: ExperimentalThreadActionTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const preferred = params && typeof params === "object" && !Array.isArray(params) && "platform" in params && params.platform === "ios" ? "ios" : "android";
  const [embeds, setEmbeds] = useState<Embeds>({ android: null, ios: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const results = await Promise.allSettled([rpc.call("revyl_embed", { threadId, platform: "android" }), rpc.call("revyl_embed", { threadId, platform: "ios" })]);
      if (!active) return;
      setEmbeds({ android: results[0].status === "fulfilled" ? results[0].value : null, ios: results[1].status === "fulfilled" ? results[1].value : null });
      setError(results.every(result => result.status === "rejected"));
      setLoading(false);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => { active = false; window.clearInterval(timer); };
  }, [rpc, threadId]);
  const platform = embeds[preferred] ? preferred : embeds[preferred === "android" ? "ios" : "android"] ? preferred === "android" ? "ios" : "android" : null;
  const url = platform ? embeds[platform] : null;
  if (!url) return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground" role="status">{loading ? "Checking for a device…" : error ? "Could not load the device." : "No device to show"}</div>;
  return <iframe title={`${platform === "ios" ? "iOS" : "Android"} Revyl device`} src={url} allow="fullscreen; clipboard-read; clipboard-write" className="h-full w-full border-0" />;
}

function DeviceReveal() {
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  useRealtime(THREAD_CHANGED, useCallback((payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const request = payload as { threadId?: unknown; platform?: unknown; issuedAt?: unknown };
    if (request.threadId === threadId && (request.platform === "ios" || request.platform === "android") && typeof request.issuedAt === "number" && Date.now() - request.issuedAt < 10_000) navigate.openThreadPanel({ actionId: "device", params: { platform: request.platform } });
  }, [navigate, threadId]));
  return null;
}

export default definePluginApp(app => {
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "device", title: "Device", icon: "Smartphone", layout: "flush", component: DevicePanel });
  app.slots.experimental_appOverlay({ id: "device-reveal", component: DeviceReveal });
});
