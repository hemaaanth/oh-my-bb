import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhoneDialResult } from "../shared/contract.js";
import { toastStore } from "../voice/toasts.js";
import { dialPhone } from "./phone-dial.js";
import { PHONE_WAIT_MS, phoneAttempt, privateCallText } from "./phone-status.js";

const rpcReturning = (result: PhoneDialResult) => ({ call: vi.fn(async () => result) }) as never;

afterEach(() => {
  toastStore.set(() => []);
  phoneAttempt.set(null);
});

describe("dialPhone", () => {
  it("sets waiting status without a success toast or provider details", async () => {
    const result = await dialPhone(rpcReturning({ status: "placed", detail: "Calling +15555550123 (Twilio call CA0123456789abcdef0123456789abcdef).", callSid: "CA0123456789abcdef0123456789abcdef" }), { agentName: "Juno" });
    expect(result?.status).toBe("placed");
    expect(toastStore.get()).toEqual([]);
    expect(phoneAttempt.get()?.phase).toBe("ringing");
    expect(JSON.stringify(phoneAttempt.get())).not.toContain("15555550123");
    expect(JSON.stringify(phoneAttempt.get())).not.toContain("CA0123456789abcdef0123456789abcdef");
  });

  it("shares dialing status while the request is pending and prevents duplicate attempts", async () => {
    let finish!: (value: PhoneDialResult) => void;
    const rpc = { call: vi.fn(() => new Promise<PhoneDialResult>((resolve) => { finish = resolve; })) };
    const first = dialPhone(rpc as never, { agentName: "Juno" });
    expect(phoneAttempt.get()?.phase).toBe("dialing");
    expect(await dialPhone(rpc as never, { agentName: "Juno" })).toBeNull();
    expect(rpc.call).toHaveBeenCalledTimes(1);
    finish({ status: "placed", detail: "private" });
    await first;
    expect(phoneAttempt.get()?.phase).toBe("ringing");
  });

  it("allows a new attempt after a stale waiting state", async () => {
    phoneAttempt.set({ phase: "ringing", at: Date.now() - PHONE_WAIT_MS - 1 });
    const rpc = rpcReturning({ status: "placed", detail: "private" });
    expect((await dialPhone(rpc, { agentName: "Juno" }))?.status).toBe("placed");
  });

  it("does not restore ringing after the server has already confirmed a live call", async () => {
    const rpc = { call: async () => { phoneAttempt.set(null); return { status: "placed", detail: "private" }; } };
    await dialPhone(rpc as never, { agentName: "Juno" });
    expect(phoneAttempt.get()).toBeNull();
  });

  it("toasts the missing labels with an action that opens settings", async () => {
    const onNotReady = vi.fn();
    await dialPhone(rpcReturning({ status: "not-ready", missing: ["Twilio Account SID", "Your phone number"] }), { agentName: "Juno", onNotReady });
    const [toast] = toastStore.get();
    expect(toast!.message).toBe("Juno cannot call your phone yet. Missing: Twilio Account SID, Your phone number.");
    expect(toast!.tone).toBe("error");
    expect(phoneAttempt.get()).toBeNull();
    toast!.action!.run();
    expect(onNotReady).toHaveBeenCalledOnce();
  });

  it("toasts the reason when Twilio refuses", async () => {
    await dialPhone(rpcReturning({ status: "error", detail: "Twilio 401: bad" }), { agentName: "Juno" });
    expect(toastStore.get().map((toast) => [toast.message, toast.tone])).toEqual([["Twilio 401: bad", "error"]]);
  });

  it("redacts provider references and international numbers in errors", async () => {
    const sid = `CA${"a".repeat(32)}`;
    await dialPhone(rpcReturning({ status: "error", detail: `Twilio 400: ${sid} could not call +15555550123` }), { agentName: "Juno" });
    expect(toastStore.get()[0]!.message).toBe("Twilio 400: [call reference] could not call •••0123");
    expect(privateCallText("Try +1 (555) 555-9876")).toBe("Try •••9876");
  });

  it("lets an RPC failure reach the caller", async () => {
    const rpc = { call: vi.fn(async () => Promise.reject(new Error("offline"))) } as never;
    await expect(dialPhone(rpc, { agentName: "Juno" })).rejects.toThrow("offline");
    expect(toastStore.get()).toHaveLength(0);
    expect(phoneAttempt.get()?.phase).toBe("failed");
  });
});
