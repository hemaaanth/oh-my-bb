import type { ExperimentalCodeFenceRendererProps } from "@get-bb/plugin-sdk/app";
import { HostContext } from "./spec/host.js";
import { useBbHost } from "./specHost.js";
import { NativeApp } from "./apps/NativeApp.js";

/** Only a closed fence executes scripts. Streaming is an inert markup preview. */
export function AppFence({ code, language, status, index, message, Original }: ExperimentalCodeFenceRendererProps) {
  const stateKey = `bb.pages.app:${message.id}#${language}#${index}`;
  const host = useBbHost("chat", { threadId: message.threadId, blockKey: stateKey, appsReady: status === "closed" });
  if (status === "unclosed" || (!code.trim() && status !== "streaming")) return <Original />;
  return <HostContext.Provider value={host}><div className="my-2 min-w-0"><NativeApp html={code} ready={status === "closed"} stateKey={stateKey} /></div></HostContext.Provider>;
}
