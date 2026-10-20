// Places a phone call from the browser and reports the result with a toast.
// Owned by P3. The pet menu, the palette command, and the console all call it.
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { PhoneDialResult, RpcContract } from "../shared/contract.js";
import { openDispatchSettings } from "../voice/settings-opener.js";
import { showToast } from "../voice/toasts.js";

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
 * Ask the server to place the call. A `placed` result toasts the detail. A
 * `not-ready` result toasts the missing items with an action that opens
 * settings, and no call was tried. An `error` result toasts the reason.
 * Returns the result. An RPC failure throws, so the caller can show it.
 */
export async function dialPhone(rpc: PluginRpcClient<RpcContract>, options: DialPhoneOptions): Promise<PhoneDialResult | null> {
  const result = await rpc.call("phoneDial", {});
  if (result.status === "placed") {
    showToast(result.detail);
  } else if (result.status === "not-ready") {
    showToast(`${options.agentName} cannot call your phone yet. Missing: ${result.missing.join(", ")}.`, {
      tone: "error",
      action: { label: "Open settings", run: options.onNotReady ?? openDispatchSettings },
    });
  } else {
    showToast(result.detail, { tone: "error" });
  }
  return result;
}
