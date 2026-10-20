// Places a phone call. Shared inline status replaces the success toast.
// Owned by P3. The pet menu, the palette command, and the console all call it.
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { PhoneDialResult, RpcContract } from "../shared/contract.js";
import { openDispatchSettings } from "../voice/settings-opener.js";
import { showToast } from "../voice/toasts.js";
import { PHONE_WAIT_MS, phoneAttempt, privateCallText } from "./phone-status.js";

export type DialPhoneOptions = {
  /** Used in toast text, never a literal name. */
  agentName: string;
  /**
   * What the "Open settings" action on the not-ready toast does. Defaults to
   * opening Dispatch settings. The dial itself never navigates on its own.
   */
  onNotReady?: () => void;
};

/**
 * Ask the server to place the call. A `placed` result updates inline status. A
 * `not-ready` result toasts the missing items with an action that opens
 * settings, and no call was tried. An `error` result toasts the reason.
 * Returns the result. An RPC failure throws, so the caller can show it.
 */
export async function dialPhone(rpc: PluginRpcClient<RpcContract>, options: DialPhoneOptions): Promise<PhoneDialResult | null> {
  const pending = phoneAttempt.get();
  if (pending && (pending.phase === "dialing" || pending.phase === "ringing") && Date.now() - pending.at < PHONE_WAIT_MS) return null;
  const attempt = { phase: "dialing" as const, at: Date.now() };
  phoneAttempt.set(attempt);
  let result: PhoneDialResult;
  try {
    result = await rpc.call("phoneDial", {});
  } catch (cause) {
    if (phoneAttempt.get() === attempt) phoneAttempt.set({ phase: "failed", at: Date.now() });
    throw new Error(privateCallText(cause instanceof Error ? cause.message : String(cause)));
  }
  // A live-status push may have already cleared the attempt while this RPC ran.
  if (phoneAttempt.get() === attempt) {
    phoneAttempt.set(result.status === "placed" ? { phase: "ringing", at: attempt.at } : result.status === "error" ? { phase: "failed", at: Date.now() } : null);
  }
  if (result.status === "not-ready") {
    showToast(`${options.agentName} cannot call your phone yet. Missing: ${result.missing.join(", ")}.`, {
      tone: "error",
      action: { label: "Open settings", run: options.onNotReady ?? openDispatchSettings },
    });
  } else if (result.status === "error") {
    showToast(privateCallText(result.detail), { tone: "error" });
  }
  return result;
}
