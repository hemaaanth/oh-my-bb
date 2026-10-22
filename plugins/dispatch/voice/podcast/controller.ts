import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { PodcastContract, PodcastSpeech } from "../../shared/podcast.js";
import type { AgentCommandPayload, CallControlPayload, Presence, RpcContract } from "../../shared/contract.js";
import { callStore, IDLE_CALL } from "../call-store.js";
import { createStore } from "../store.js";
import { acquireMic } from "../mic.js";
import { waitForIce } from "../peer.js";
import { deviceProfile } from "../device-profile.js";
import { clientId, randomId, REALM_ID } from "../local.js";
import { currentBindings } from "../bindings.js";
import { readAudioChoice } from "../audio-devices.js";
import { showToast } from "../toasts.js";
import { PodcastQueue, PodcastVad } from "./queue.js";

type Rpc = PluginRpcClient<PodcastContract & RpcContract>;
type Session = { callId: string; token: string };
type Transcript = { id: string; speaker: string; text: string; interrupted?: boolean };
export const podcastStore = createStore({ active: false, connecting: false, speaker: "", pending: 0, hold: false, busy: false, muted: false, error: "", transcript: [] as Transcript[] });
const patch = (next: Partial<ReturnType<typeof podcastStore.get>>) => podcastStore.set(s => ({ ...s, ...next }));
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export class PodcastController {
  private session: Session | null = null;
  private nonce: string | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private queue = new PodcastQueue();
  private vad: PodcastVad | null = null;
  private work: Promise<unknown> | null = null;
  private cancellation: Promise<unknown> = Promise.resolve();
  private lastClear = 0;
  private audio: HTMLAudioElement | null = null;
  private speakingProject: string | null = null;
  private playbackEnd: (() => void) | null = null;
  private lastUser = 0;
  private startedAt: number | null = null;
  private polling = false;
  private nextPollAt = 0;
  private draining = false;
  private activeRequest: { id: string; generation: number } | null = null;
  private commits: string[] = [];
  private completed = new Map<string, string>();
  constructor(private readonly rpc: Rpc) {}
  get active() { return this.nonce !== null; }
  private live(nonce: string) { return this.nonce === nonce; }
  private addTranscript(item: Transcript) { patch({ transcript: [...podcastStore.get().transcript.slice(-99), item] }); }
  private fail(error: unknown) {
    const text = errorText(error); const repeated = podcastStore.get().error === text;
    patch({ error: text }); if (!repeated) showToast(`Podcast: ${text}`, { tone: "error" });
  }

  async start() {
    if (this.active) return;
    if (callStore.get().state !== "idle") { this.fail(new Error("End the current call before starting Podcast.")); return; }
    const nonce = randomId(); this.nonce = nonce; this.queue.clear(); this.nextPollAt = 0;
    patch({ active: true, connecting: true, speaker: "", error: "", transcript: [], pending: 0, hold: false, muted: false });
    callStore.set({ ...IDLE_CALL, state: "connecting", owner: "self", nonce });
    // Start the browser's audio context inside the button gesture.
    this.audioContext = new AudioContext();
    try {
      await this.audioContext.resume();
      const stream = await acquireMic(navigator.mediaDevices);
      if (!this.live(nonce)) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      stream.getAudioTracks()[0]?.addEventListener("ended", () => { if (this.live(nonce)) { this.fail(new Error("The microphone disconnected. Start Podcast again.")); void this.stop(); } });
      const pc = new RTCPeerConnection(); this.pc = pc;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      const channel = pc.createDataChannel("oai-events"); this.channel = channel;
      channel.addEventListener("message", event => { if (this.live(nonce)) this.event(event.data); });
      channel.addEventListener("open", () => { if (this.live(nonce)) this.ready(nonce); });
      channel.addEventListener("close", () => { if (this.live(nonce)) { this.fail(new Error("Transcription disconnected. Start Podcast again.")); void this.stop(); } });
      pc.addEventListener("connectionstatechange", () => { if (this.live(nonce) && pc.connectionState === "failed") { this.fail(new Error("The voice connection failed.")); void this.stop(); } });
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await waitForIce(pc);
      if (!this.live(nonce)) return;
      const answer = await this.rpc.call("podcastOpen", { sdp: pc.localDescription?.sdp ?? "", nonce, clientId: clientId(), device: deviceProfile() });
      if (!this.live(nonce)) { await this.rpc.call("podcastClose", { callId: answer.callId, token: answer.token }).catch(() => undefined); return; }
      this.session = { callId: answer.callId, token: answer.token };
      callStore.set({ ...callStore.get(), callId: answer.callId });
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      if (channel.readyState === "open") this.ready(nonce);
      else this.connectTimeout = setTimeout(() => { if (this.live(nonce) && podcastStore.get().connecting) { this.fail(new Error("Transcription did not become ready.")); void this.stop(); } }, 20000);
    } catch (error) { if (this.live(nonce)) { this.fail(error); await this.stop(); } }
  }
  private ready(nonce: string) {
    if (!this.session || !this.stream || !this.audioContext || this.timer) return;
    if (this.connectTimeout) clearTimeout(this.connectTimeout);
    this.startedAt = Date.now(); this.lastUser = Date.now(); this.lastClear = Date.now(); patch({ connecting: false }); this.renderCall(); this.presence();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    const analyser = this.audioContext.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    this.vad = new PodcastVad(() => this.interrupt(), () => {
      if (this.channel?.readyState === "open") this.channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      this.lastUser = Date.now(); this.renderCall();
    });
    this.timer = setInterval(() => {
      if (!this.live(nonce)) return;
      let quiet = true;
      if (!podcastStore.get().muted) {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        quiet = rms < 0.01;
        this.vad?.sample(rms, Date.now());
      }
      if (this.vad?.speaking) this.lastUser = Date.now();
      else if (quiet && Date.now() - this.lastClear > 10000 && this.channel?.readyState === "open" && !this.commits.length) {
        // Dedicated transcription keeps uncommitted audio. Discard idle silence before it fills the buffer.
        this.channel.send(JSON.stringify({ type: "input_audio_buffer.clear" })); this.lastClear = Date.now();
      }
      if (!this.vad?.speaking && Date.now() - this.lastUser > 1000) void this.settle();
    }, 50);
    this.heartbeat = setInterval(() => this.presence(), 5000);
  }
  private event(raw: unknown) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(String(raw)); } catch { return; }
    if (event.type === "input_audio_buffer.committed" && typeof event.item_id === "string") this.commits.push(event.item_id);
    if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.item_id === "string" && typeof event.transcript === "string") this.completed.set(event.item_id, event.transcript);
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      const id = String(event.item_id); this.commits = this.commits.filter(item => item !== id); this.completed.delete(id);
      this.fail(new Error("Transcription failed for that turn. Please repeat it."));
    }
    // Completion messages may arrive out of order. Preserve audio commit order.
    while (this.commits.length && this.completed.has(this.commits[0]!)) {
      const id = this.commits.shift()!; const text = this.completed.get(id)!; this.completed.delete(id);
      if (text.trim()) void this.turn(text);
    }
    if (event.type === "error") { this.fail(new Error("The transcription service rejected a request. Start Podcast again if this continues.")); }
  }
  private interrupt() {
    this.lastUser = Date.now(); this.queue.interrupt();
    this.playbackEnd?.(); this.audio?.pause();
    patch({ speaker: "" }); this.renderCall();
    if (this.session) {
      const cancel = this.rpc.call("podcastCancel", this.session).catch(() => undefined);
      this.cancellation = Promise.all([this.cancellation, cancel]);
    }
  }
  async turn(text: string) {
    const session = this.session; const nonce = this.nonce;
    if (!session || !nonce || !text.trim()) return;
    this.interrupt(); const generation = this.queue.generation;
    this.addTranscript({ id: randomId(), speaker: "You", text });
    const prior = this.work;
    // Preserve ordered user turns while allowing an interruption to cancel obsolete reasoning.
    const work = (async () => {
      await Promise.all([prior?.catch(() => undefined), this.cancellation]);
      if (!this.live(nonce) || generation !== this.queue.generation) return;
      patch({ busy: true });
      try {
        const requestId = randomId(); this.activeRequest = { id: requestId, generation };
        const result = await this.rpc.call("podcastTurn", { ...session, requestId, text, projectId: currentBindings()?.context().projectId ?? null, threadId: currentBindings()?.context().threadId ?? null });
        if (this.live(nonce)) { this.queue.add(result.speeches, generation); patch({ hold: result.hold }); }
      } catch (error) { if (this.live(nonce) && generation === this.queue.generation) this.fail(error); }
      finally { if (this.live(nonce)) patch({ busy: false }); }
    })();
    this.work = work; await work;
    if (this.work === work) this.work = null;
    if (this.live(nonce)) void this.settle();
  }
  onRoster(payload: { callId: string; projectIds: string[] }) {
    if (this.session?.callId !== payload.callId) return;
    const ids = new Set(payload.projectIds);
    if (this.speakingProject && !ids.has(this.speakingProject)) this.interrupt();
    this.queue.retainProjects(ids);
  }
  onSpeech(payload: { callId: string; requestId: string; speech: PodcastSpeech }) {
    const request = this.activeRequest;
    if (this.session?.callId !== payload.callId || !request || request.id !== payload.requestId) return;
    this.queue.add([payload.speech], request.generation);
  }
  private async settle() {
    if (!this.session || this.vad?.speaking || podcastStore.get().connecting || this.draining || Date.now() - this.lastUser < 1000 || this.commits.length) return;
    const next = this.queue.next(podcastStore.get().hold);
    if (next) { await this.speak(next); return; }
    if (this.polling || this.work || Date.now() < this.nextPollAt) return;
    const session = this.session; const nonce = this.nonce!; const generation = this.queue.generation;
    this.polling = true;
    const work = this.rpc.call("podcastUpdates", session);
    this.work = work;
    try {
      const result = await work;
      if (this.live(nonce)) { patch({ pending: result.pending, hold: result.hold }); this.queue.add(result.speeches, generation); }
    } catch (error) {
      this.nextPollAt = Date.now() + 10000;
      if (this.live(nonce) && generation === this.queue.generation) this.fail(error);
    }
    finally { if (this.work === work) this.work = null; this.polling = false; }
    // Poll at most once per second, including when the server has no updates.
    this.nextPollAt = Math.max(this.nextPollAt, Date.now() + 1000);
  }
  private async speak(speech: PodcastSpeech) {
    const session = this.session; const nonce = this.nonce!; const generation = this.queue.generation;
    if (!session) return;
    this.draining = true;
    let url: string | null = null;
    try {
      const sound = await this.rpc.call("podcastAudio", { ...session, speechId: speech.id });
      if (!this.live(nonce) || generation !== this.queue.generation || this.vad?.speaking) return;
      const bytes = Uint8Array.from(atob(sound.audio), char => char.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: sound.mime }));
      const audio = document.createElement("audio"); audio.src = url; audio.setAttribute("playsinline", ""); audio.hidden = true; document.body.append(audio); this.audio = audio;
      const output = readAudioChoice().outputDeviceId;
      const sink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (output && sink.setSinkId) await sink.setSinkId(output).catch(() => undefined);
      const ended = new Promise<boolean>((resolve, reject) => {
        this.playbackEnd = () => resolve(false);
        audio.onended = () => resolve(true); audio.onerror = () => reject(new Error("The spoken answer could not play."));
      });
      this.speakingProject = speech.projectId;
      patch({ speaker: speech.speaker }); this.renderCall();
      this.addTranscript({ id: speech.id, speaker: speech.speaker, text: speech.text });
      await this.rpc.call("podcastSpeaking", { ...session, speechId: speech.id });
      if (!this.live(nonce) || generation !== this.queue.generation) return;
      await audio.play();
      const heard = await ended;
      if (heard && this.live(nonce)) {
        await this.rpc.call("podcastHeard", { ...session, speechId: speech.id }); this.queue.heard(speech.id);
      } else patch({ transcript: podcastStore.get().transcript.map(item => item.id === speech.id ? { ...item, interrupted: true } : item) });
    } catch (error) {
      if (this.live(nonce) && generation === this.queue.generation) { this.fail(error); this.queue.heard(speech.id); }
    } finally {
      this.audio?.pause(); this.audio?.remove(); this.audio = null; this.playbackEnd = null;
      if (url) URL.revokeObjectURL(url);
      this.draining = false; this.speakingProject = null;
      if (this.live(nonce)) { patch({ speaker: "" }); this.renderCall(); }
    }
  }
  toggleMute() {
    if (!this.active) return;
    const muted = !podcastStore.get().muted;
    this.stream?.getTracks().forEach(t => { t.enabled = !muted; });
    this.vad?.reset(); patch({ muted }); this.renderCall(); this.presence();
  }
  onCommand(command: AgentCommandPayload) {
    if (!this.active || (command.nonce && command.nonce !== this.nonce)) return;
    if (command.command === "stop") void this.stop();
    else if ((command.command === "mute") !== podcastStore.get().muted) this.toggleMute();
  }
  onControl(control: CallControlPayload) { if (this.active && (control.nonce === null || control.nonce !== this.nonce)) void this.stop(false); }
  presence() {
    if (!this.nonce) return;
    if (this.session) {
      const nonce = this.nonce;
      void this.rpc.call("podcastHeartbeat", this.session).catch(error => { if (this.live(nonce)) { this.fail(error); void this.stop(false); } });
    }
    void this.rpc.call("announcePresence", { nonce: this.nonce, clientId: clientId(), realmId: REALM_ID, phase: podcastStore.get().connecting ? "connecting" : podcastStore.get().muted ? "muted" : "live", startedAt: this.startedAt }).catch(() => undefined);
  }
  private renderCall() {
    if (!this.nonce) return;
    callStore.set({ ...IDLE_CALL, nonce: this.nonce, callId: this.session?.callId ?? null, owner: "self", state: podcastStore.get().connecting ? "connecting" : podcastStore.get().muted ? "muted" : "live", startedAt: this.startedAt, activity: this.vad?.speaking ? "you" : podcastStore.get().speaker ? "agent" : "idle" });
  }
  async stop(server = true) {
    const nonce = this.nonce; const session = this.session; if (!nonce) return;
    this.nonce = null; this.queue.clear(); this.playbackEnd?.(); this.audio?.pause(); this.audio?.remove(); this.audio = null;
    if (this.timer) clearInterval(this.timer); if (this.heartbeat) clearInterval(this.heartbeat); if (this.connectTimeout) clearTimeout(this.connectTimeout);
    this.timer = null; this.heartbeat = null; this.connectTimeout = null;
    this.channel?.close(); this.pc?.close(); this.stream?.getTracks().forEach(t => t.stop());
    const closing = server && session ? this.rpc.call("podcastClose", session).catch(() => undefined) : Promise.resolve();
    const closedAudio = this.audioContext?.close().catch(() => undefined);
    this.pc = null; this.channel = null; this.stream = null; this.audioContext = null; this.vad = null;
    this.activeRequest = null; this.session = null; this.startedAt = null; this.commits = []; this.completed.clear();
    patch({ active: false, connecting: false, speaker: "", busy: false, muted: false });
    if (callStore.get().nonce === nonce) callStore.set(IDLE_CALL);
    await Promise.all([closing, closedAudio]);
    await this.rpc.call("announcePresence", { nonce, clientId: clientId(), realmId: REALM_ID, phase: "idle", startedAt: null }).catch(() => undefined);
  }
}

let controller: PodcastController | null = null;
export const podcastEngine = () => controller;
export function installPodcast(rpc: Rpc) {
  const installed = new PodcastController(rpc); controller = installed;
  const hide = () => void installed.stop();
  window.addEventListener("pagehide", hide);
  return () => { window.removeEventListener("pagehide", hide); void installed.stop(); if (controller === installed) controller = null; };
}
