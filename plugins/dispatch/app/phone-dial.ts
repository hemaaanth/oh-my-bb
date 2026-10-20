// Places a phone call from the browser and reports the result with a toast.
// Owned by P3. The pet menu, the palette command, and the console all call it.
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { PhoneDialResult, RpcContract } from "../shared/contract.js";

export type DialPhoneOptions = {
  /** Used in toast text, never a literal name. */
  agentName: string;
  /** Called on a `not-ready` result so the caller can open Dispatch settings. */
  onNotReady?: () => void;
};

export async function dialPhone(_rpc: PluginRpcClient<RpcContract>, _options: DialPhoneOptions): Promise<PhoneDialResult | null> {
  return null;
}
