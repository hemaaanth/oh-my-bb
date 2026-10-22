// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PodcastController, podcastStore } from "./controller.js";
import { callStore, IDLE_CALL } from "../call-store.js";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { PodcastContract } from "../../shared/podcast.js";
import type { RpcContract } from "../../shared/contract.js";
vi.mock("../toasts.js", () => ({ showToast: vi.fn() }));
class Channel extends EventTarget {
  readyState = "connecting";
  sent: unknown[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = "closed"; }
}
class Peer extends EventTarget {
  static current: Peer;
  localDescription = { sdp: "v=0" };
  iceGatheringState = "complete";
  channel = new Channel();
  constructor() { super(); Peer.current = this; }
  addTrack() {}
  createDataChannel() { return this.channel; }
  async createOffer() { return this.localDescription; }
  async setLocalDescription() {}
  async setRemoteDescription() { this.channel.readyState = "open"; this.channel.dispatchEvent(new Event("open")); }
  close() {}
}
class Context {
  async resume() {}
  async close() {}
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(data: Float32Array) { data.fill(0); } }; }
}
const controllers: PodcastController[] = [];
beforeEach(() => {
  vi.useFakeTimers(); callStore.set(IDLE_CALL);
  vi.stubGlobal("AudioContext", Context); vi.stubGlobal("RTCPeerConnection", Peer);
  const track = Object.assign(new EventTarget(), { stop: vi.fn(), enabled: true });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [{ kind: "audioinput", deviceId: "mic" }], getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.stop(); callStore.set(IDLE_CALL); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function controller(override?: (method: string, input: Record<string, unknown>) => Promise<unknown>) {
  const call = vi.fn(async (method: string, input: Record<string, unknown>) => {
    const result = await override?.(method, input); if (result !== undefined) return result;
    if (method === "podcastOpen") return { callId: "call", token: "token", sdp: "v=0" };
    if (method === "podcastUpdates") return { speeches: [], pending: 0, hold: false };
    if (method === "podcastTurn") return { speeches: [], hold: false };
    if (method === "podcastAudio") return { audio: "AQID", mime: "audio/mpeg" };
    return { ok: true };
  });
  const engine = new PodcastController({ call } as unknown as PluginRpcClient<PodcastContract & RpcContract>); controllers.push(engine); return { engine, call };
}
const speech = { id: "speech", projectId: "project", speaker: "Site", text: "I sent the instruction.", updateId: null };
describe("Podcast browser lifecycle", () => {
  it("shares mute and call state, then closes only its own server session", async () => {
    const { engine, call } = controller(); await engine.start();
    expect(callStore.get()).toMatchObject({ state: "live", owner: "self", callId: "call" });
    engine.toggleMute(); expect(callStore.get().state).toBe("muted");
    await engine.stop(); expect(callStore.get().state).toBe("idle");
    expect(call).toHaveBeenCalledWith("podcastClose", { callId: "call", token: "token" });
    expect(call.mock.calls.some(([name]) => name === "endCallsEverywhere")).toBe(false);
  });
  it("does not start a second call while regular Dispatch is live", async () => {
    callStore.set({ ...IDLE_CALL, state: "live", callId: "regular" });
    const { engine, call } = controller(); await engine.start();
    expect(call).not.toHaveBeenCalledWith("podcastOpen", expect.anything()); expect(engine.active).toBe(false);
  });
  it("cleans up a session that opened after the user stopped connecting", async () => {
    let opened!: (answer: unknown) => void;
    const { engine, call } = controller(async method => method === "podcastOpen" ? new Promise(resolve => { opened = resolve; }) : undefined);
    const start = engine.start(); await vi.advanceTimersByTimeAsync(1);
    await engine.stop(); opened({ callId: "late", token: "late-token", sdp: "v=0" }); await start;
    expect(call).toHaveBeenCalledWith("podcastClose", { callId: "late", token: "late-token" });
    expect(engine.active).toBe(false);
  });
  it("finishes cancellation before sending the next user instruction", async () => {
    let finishCancel!: (answer: unknown) => void;
    const { engine, call } = controller(async method => method === "podcastCancel" ? new Promise(resolve => { finishCancel = resolve; }) : undefined);
    await engine.start(); const turn = engine.turn("Start a test thread");
    await vi.advanceTimersByTimeAsync(1);
    expect(call.mock.calls.some(([name]) => name === "podcastTurn")).toBe(false);
    finishCancel({ ok: true }); await turn;
    expect(call.mock.calls.some(([name]) => name === "podcastTurn")).toBe(true);
  });
  it("streams the first speaker before the full turn finishes and acknowledges only completed playback", async () => {
    let finishTurn!: (answer: unknown) => void;
    const { engine, call } = controller(async method => method === "podcastTurn" ? new Promise(resolve => { finishTurn = resolve; }) : undefined);
    await engine.start(); const turn = engine.turn("How are the projects?"); await vi.advanceTimersByTimeAsync(1);
    const request = call.mock.calls.find(([name]) => name === "podcastTurn")![1];
    engine.onSpeech({ callId: "call", requestId: String(request.requestId), speech });
    await vi.advanceTimersByTimeAsync(1100);
    expect(podcastStore.get().speaker).toBe("Site");
    expect(call.mock.calls.some(([name]) => name === "podcastHeard")).toBe(false);
    const audio = document.querySelector("audio")!; audio.dispatchEvent(new Event("ended"));
    await vi.advanceTimersByTimeAsync(1);
    expect(call).toHaveBeenCalledWith("podcastHeard", { callId: "call", token: "token", speechId: "speech" });
    finishTurn({ speeches: [speech], hold: false }); await turn;
    await vi.advanceTimersByTimeAsync(1100);
    expect(call.mock.calls.filter(([name]) => name === "podcastAudio")).toHaveLength(1);
  });
});
