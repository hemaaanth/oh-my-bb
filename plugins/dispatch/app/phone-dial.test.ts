import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhoneDialResult } from "../shared/contract.js";
import { toastStore } from "../voice/toasts.js";
import { dialPhone } from "./phone-dial.js";

const rpcReturning = (result: PhoneDialResult) => ({ call: vi.fn(async () => result) }) as never;

afterEach(() => toastStore.set(() => []));

describe("dialPhone", () => {
  it("toasts the detail when the call is placed", async () => {
    const result = await dialPhone(rpcReturning({ status: "placed", detail: "Calling +1555 (Twilio call CA1).", callSid: "CA1" }), { agentName: "Juno" });
    expect(result?.status).toBe("placed");
    expect(toastStore.get().map((toast) => [toast.message, toast.tone])).toEqual([["Calling +1555 (Twilio call CA1).", "info"]]);
  });

  it("toasts the missing labels with an action that opens settings", async () => {
    const onNotReady = vi.fn();
    await dialPhone(rpcReturning({ status: "not-ready", missing: ["Twilio Account SID", "Your phone number"] }), { agentName: "Juno", onNotReady });
    const [toast] = toastStore.get();
    expect(toast!.message).toBe("Juno cannot call your phone yet. Missing: Twilio Account SID, Your phone number.");
    expect(toast!.tone).toBe("error");
    toast!.action!.run();
    expect(onNotReady).toHaveBeenCalledOnce();
  });

  it("toasts the reason when Twilio refuses", async () => {
    await dialPhone(rpcReturning({ status: "error", detail: "Twilio 401: bad" }), { agentName: "Juno" });
    expect(toastStore.get().map((toast) => [toast.message, toast.tone])).toEqual([["Twilio 401: bad", "error"]]);
  });

  it("lets an RPC failure reach the caller", async () => {
    const rpc = { call: vi.fn(async () => Promise.reject(new Error("offline"))) } as never;
    await expect(dialPhone(rpc, { agentName: "Juno" })).rejects.toThrow("offline");
    expect(toastStore.get()).toHaveLength(0);
  });
});
