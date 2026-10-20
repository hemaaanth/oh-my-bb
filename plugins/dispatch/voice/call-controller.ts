// The in-app call (SPEC §5). One controller per realm. It starts and stops the
// WebRTC session, handles the data channel events, runs tools through the
// dispatcher, keeps presence in step across realms, and watches the mic.
//
// Everything outside the browser comes in through `ControllerDeps`
// (call-session.ts), so the tests drive it with a fake peer connection, mic
// and RPC client.

import { GREETING_NOTICE } from "@/shared/constants.js";
import type { AgentCommandPayload, CallControlPayload, Presence, ThreadNoticePayload } from "@/shared/contract.js";
import { TOOL_ERROR_PREFIX } from "@/shared/tool-names.js";
import { TranscriptGrouper, speechKind } from "@/shared/transcript.js";
import { callStore, IDLE_CALL, type Activity, type CallSnapshot } from "./call-store.js";
import { DEFAULT_TIMING, type ControllerDeps, type Session, type Teardown, type Timing } from "./call-session.js";
import { canNavigate } from "./device-profile.js";
import { continueEvent, functionOutputEvent, noticeEvent, parseLiveEvent, type LiveEvent } from "./live-events.js";
import { randomId } from "./local.js";
import { acquireMic, MicError } from "./mic.js";
import { NoticeBatcher } from "./notices.js";
import { waitForIce } from "./peer.js";
import { PresenceMirror, type Mirror } from "./presence-mirror.js";
import type { Store } from "./store.js";
import { TraceQueue } from "./trace.js";

export { DEFAULT_TIMING, type ControllerDeps, type Timing } from "./call-session.js";

const messageOf = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : String(cause));

export class CallController {
  private session: Session | null = null;
  private readonly timing: Timing;
  private readonly store: Store<CallSnapshot>;
  private readonly trace: TraceQueue;
  private readonly mirror: PresenceMirror;
  private readonly notices: NoticeBatcher;
  private readonly transcript: TranscriptGrouper;
  private lastMirrorStop = 0;

  constructor(private readonly deps: ControllerDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.store = deps.store ?? callStore;
    this.trace = new TraceQueue((callId, events) => deps.rpc.call("traceAppend", { callId, events }), this.timing.traceDelayMs);
    this.mirror = new PresenceMirror(() => this.render(), this.timing.staleMs);
    this.notices = new NoticeBatcher((digest) => this.queueNotice(digest), this.timing.noticeWindowMs);
    // GPT-Live sends transcript fragments only. One speech row per utterance.
    this.transcript = new TranscriptGrouper((utterance) => this.trace.record(speechKind(utterance.speaker), { text: utterance.text }, utterance.at));
  }

  /** Add a trace event to the current call. Dropped when no call runs. */
  record(kind: string, payload?: Record<string, unknown>) {
    if (this.session) this.trace.record(kind, payload);
  }

  /** The pet tap, the shortcut and the palette command (SPEC §5.2 step 2). */
  async toggle(): Promise<void> {
    if (this.session) return this.stop("user");
    if (this.mirror.current) return this.stopMirror(this.mirror.current);
    return this.start();
  }

  /** Start only when no call runs anywhere this realm knows of. */
  async wake(): Promise<void> {
    if (this.session || this.mirror.current) return;
    return this.start();
  }

  async toggleMute(): Promise<void> {
    const call = this.store.get();
    return this.setMuted(call.state !== "muted");
  }

  async setMuted(muted: boolean): Promise<void> {
    const session = this.session;
    if (session) {
      if (session.muted === muted) return;
      session.muted = muted;
      if (session.track) session.track.enabled = !muted;
      if (session.state !== "connecting") session.state = muted ? "muted" : "live";
      this.trace.record("mute", { muted });
      this.announce(session);
      this.render();
      return;
    }
    const mirror = this.mirror.current;
    if (mirror) {
      await this.deps.rpc.call("relayCommand", { command: muted ? "mute" : "unmute", nonce: mirror.nonce }).catch(() => undefined);
    }
  }

  /** Stop this realm's own call. Idempotent (SPEC §5.7). */
  async stop(reason = "user"): Promise<void> {
    const session = this.session;
    if (session) this.teardown(session, { reason, server: true, record: "call.stopped" });
  }

  // --- Realtime input (wired by the bindings overlay) -------------------------

  onPresence(presence: Presence) {
    // Own echoes and anything heard while owning a call are ignored (SPEC §5.5).
    if (presence.realmId === this.deps.realmId || this.session) return;
    this.mirror.apply(presence);
  }

  onPresencePing() {
    if (this.session) this.announce(this.session);
  }

  onAgentCommand({ command, nonce }: AgentCommandPayload) {
    const session = this.session;
    if (!session || (nonce !== null && nonce !== session.nonce)) return;
    if (command === "stop") void this.stop("relayed");
    else void this.setMuted(command === "mute");
  }

  onCallControl({ nonce, reason }: CallControlPayload) {
    const session = this.session;
    // A null nonce stops everything. Another nonce means a newer call started.
    if (session && (nonce === null || nonce !== session.nonce)) {
      this.teardown(session, { reason: reason || "replaced", server: false, record: "call.stopped" });
    }
    if (nonce === null) this.mirror.clear();
  }

  onThreadNotice(notice: ThreadNoticePayload) {
    const session = this.session;
    if (!session || session.state === "connecting" || !this.deps.prefs().announcements) return;
    this.notices.add(notice);
  }

  /** The page became visible or hidden. */
  onVisibility() {
    const visible = this.deps.visible();
    const session = this.session;
    if (!session) return;
    this.trace.record("page.visibility", { visible });
    if (visible && this.micUnhealthy(session)) void this.recover(session);
  }

  /** Page hide or plugin unmount (SPEC §5.6). */
  dispose(reason = "pagehide") {
    void this.stop(reason);
    this.mirror.clear();
    this.notices.clear();
  }

  // --- Starting ---------------------------------------------------------------

  private async start(): Promise<void> {
    const name = this.deps.agentName();
    const setup = this.deps.setup();
    if (setup && !setup.voice.ready) {
      this.deps.toast(`${name} needs an OpenAI API key. Open Dispatch settings.`, {
        tone: "error",
        action: { label: "Open settings", run: this.deps.openSettings },
      });
      return;
    }
    const session: Session = {
      nonce: randomId(),
      callId: null,
      state: "connecting",
      muted: false,
      startedAt: null,
      activity: "idle",
      micSuspended: false,
      pc: null,
      channel: null,
      stream: null,
      track: null,
      sender: null,
      audio: null,
      detachTrack: null,
      heartbeat: null,
      pending: new Set(),
      answered: 0,
      responseActive: false,
      queuedNotice: null,
      recovering: false,
      ending: false,
      ended: false,
    };
    this.session = session;
    this.mirror.clear();
    this.trace.begin();
    this.transcript.dispose();
    this.store.set({ ...IDLE_CALL, state: "connecting", owner: "self", nonce: session.nonce });
    this.announce(session);

    let stage = "mic";
    try {
      const stream = await acquireMic(this.deps.media(), this.timing.micTimeoutMs);
      if (session.ended) return stream.getTracks().forEach((track) => track.stop());
      const track = stream.getAudioTracks()[0];
      if (!track) throw new MicError("The microphone gave no audio.", "missing");
      session.stream = stream;
      this.useTrack(session, track);
      this.trace.record("audio.input", { label: track.label });

      stage = "connect";
      const pc = this.deps.createPeer();
      session.pc = pc;
      session.sender = pc.addTrack(track, stream);
      this.watchPeer(session, pc);
      const channel = pc.createDataChannel("oai-events");
      session.channel = channel;
      this.watchChannel(session, channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc, this.timing.iceTimeoutMs);
      if (session.ended) return;

      stage = "open";
      const profile = this.deps.profile;
      const answer = await this.deps.rpc.call("openCall", {
        sdp: pc.localDescription?.sdp ?? offer.sdp ?? "",
        nonce: session.nonce,
        clientId: this.deps.clientId,
        realmId: this.deps.realmId,
        device: profile,
        context: { ...this.deps.screen(), mobile: profile.mobile, canNavigate: canNavigate(profile), channel: "app" },
      });
      if (session.ended) {
        // Stopped while the server was opening it: end the call it just made.
        void this.deps.rpc.call("endCallsEverywhere", { nonce: session.nonce, reason: "user" }).catch(() => undefined);
        return;
      }
      session.callId = answer.callId;
      this.trace.attach(answer.callId);
      this.render();
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (cause) {
      if (!session.ended) this.fail(session, stage, cause);
    }
  }

  private fail(session: Session, stage: string, cause: unknown) {
    const message = messageOf(cause);
    this.trace.record("error", { stage, message });
    this.deps.toast(`${this.deps.agentName()}: ${message}`, { tone: "error" });
    this.teardown(session, { reason: "failed", server: session.callId !== null, record: "call.stopped", extra: { stage } });
  }

  private watchPeer(session: Session, pc: RTCPeerConnection) {
    pc.addEventListener("track", (event) => {
      if (session.ended) return;
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      session.audio ??= this.deps.createAudio();
      const audio = session.audio;
      void audio.play(stream);
      void audio.route(this.deps.outputDeviceId()).then((routed) => this.trace.record("audio.output", { routed }));
    });
    pc.addEventListener("connectionstatechange", () => {
      if (session.ended) return;
      this.trace.record("conn.state", { state: pc.connectionState });
      if (pc.connectionState === "failed") this.fail(session, "connection", new Error("The connection to the voice service failed."));
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      if (!session.ended) this.trace.record("conn.ice", { state: pc.iceConnectionState });
    });
  }

  private watchChannel(session: Session, channel: RTCDataChannel) {
    channel.addEventListener("open", () => {
      if (!session.ended) this.trace.record("conn.channel", { state: "open" });
    });
    channel.addEventListener("close", () => {
      if (session.ended) return;
      this.trace.record("conn.channel", { state: "closed" });
      this.teardown(session, { reason: "channel closed", server: true, record: "call.closed" });
    });
    channel.addEventListener("message", (event: MessageEvent) => this.handle(session, parseLiveEvent(event.data)));
  }

  // --- During the call --------------------------------------------------------

  private handle(session: Session, event: LiveEvent | null) {
    if (!event || session.ended) return;
    switch (event.kind) {
      case "started":
        if (session.state !== "connecting") return;
        session.state = session.muted ? "muted" : "live";
        session.startedAt = Date.now();
        this.deps.chimes.ready();
        this.trace.record("client.ready", {});
        session.heartbeat = setInterval(() => this.announce(session), this.timing.heartbeatMs);
        this.announce(session);
        // Speak first, so the owner knows the call is ready.
        session.queuedNotice = GREETING_NOTICE;
        this.settle(session);
        this.render();
        return;
      case "transcript": {
        const activity: Activity = event.final && event.speaker === "you" ? "idle" : event.speaker;
        this.recordTranscript(event);
        this.setActivity(session, activity);
        return;
      }
      case "response":
        session.responseActive = event.active;
        if (!event.active) {
          this.setActivity(session, "idle");
          queueMicrotask(() => this.settle(session));
        }
        return;
      case "function-call":
        void this.runTool(session, event);
        return;
      case "usage":
        this.trace.record("usage.seconds", { seconds: event.seconds });
        return;
      case "closed":
        this.teardown(session, {
          reason: event.reason,
          server: false,
          record: "call.closed",
          ...(event.seconds === null ? {} : { extra: { seconds: event.seconds } }),
        });
        return;
      case "error":
        this.trace.record("error", { message: event.message, transient: event.transient });
        // A refused continue leaves no response running.
        session.responseActive = false;
        if (!event.transient) this.deps.toast(`${this.deps.agentName()}: ${event.message}`, { tone: "error" });
        return;
    }
  }

  private recordTranscript(event: Extract<LiveEvent, { kind: "transcript" }>) {
    const speaker = event.speaker === "you" ? "user" : "agent";
    if (!event.final) {
      this.transcript.push({ speaker, text: event.text, startMs: event.startMs, endMs: event.endMs });
      return;
    }
    // A final event ends the turn. Its text only counts when no fragments came first.
    if (this.transcript.openSpeaker === speaker) this.transcript.flush();
    else if (event.text.trim()) this.trace.record(speechKind(speaker), { text: event.text.trim() });
  }

  private setActivity(session: Session, activity: Activity) {
    if (session.activity === activity) return;
    session.activity = activity;
    this.render();
  }

  private async runTool(session: Session, call: Extract<LiveEvent, { kind: "function-call" }>) {
    session.pending.add(call.callId);
    let output: string;
    try {
      output = await this.deps.runTool({ callId: call.callId, name: call.name, args: call.args });
    } catch (cause) {
      output = `${TOOL_ERROR_PREFIX}${messageOf(cause)}`;
    }
    session.pending.delete(call.callId);
    if (session.ended) return;
    this.send(session, functionOutputEvent(call.callId, output));
    session.answered += 1;
    // Outputs that land in the same tick share one continue.
    queueMicrotask(() => this.settle(session));
  }

  /**
   * Once every call in a batch has its output and the response that asked for
   * them has ended, ask the model to go on, once. A waiting notice rides along.
   */
  private settle(session: Session) {
    if (session.ended || session.responseActive || session.pending.size > 0) return;
    const notice = session.queuedNotice;
    if (session.answered === 0 && notice === null) return;
    session.answered = 0;
    session.queuedNotice = null;
    if (notice !== null) {
      this.send(session, noticeEvent(notice));
      this.trace.record("notice", { digest: notice });
    }
    this.send(session, continueEvent());
    // Until the response starts, a second settle must not send another continue.
    session.responseActive = true;
  }

  private queueNotice(digest: string) {
    const session = this.session;
    if (!session || session.state === "connecting") return;
    session.queuedNotice = session.queuedNotice ? `${session.queuedNotice}\n\n${digest}` : digest;
    this.settle(session);
  }

  private send(session: Session, event: unknown) {
    const channel = session.channel;
    if (!channel || channel.readyState !== "open") return;
    try {
      channel.send(JSON.stringify(event));
    } catch {
      // The close event follows and ends the call.
    }
  }

  // --- Microphone (SPEC §5.6) -------------------------------------------------

  private useTrack(session: Session, track: MediaStreamTrack) {
    track.enabled = !session.muted;
    const onMute = () => {
      this.trace.record("mic.track", { event: "mute", visible: this.deps.visible() });
      if (!this.deps.visible()) void this.suspendHidden(session);
      else this.micLost(session, "muted");
    };
    const onUnmute = () => {
      this.trace.record("mic.track", { event: "unmute" });
    };
    const onEnded = () => {
      this.trace.record("mic.track", { event: "ended" });
      this.micLost(session, "ended");
    };
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    track.addEventListener("ended", onEnded);
    session.track = track;
    session.detachTrack = () => {
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
      track.removeEventListener("ended", onEnded);
    };
  }

  private micUnhealthy(session: Session) {
    const track = session.track;
    return session.micSuspended || !track || track.readyState === "ended" || track.muted;
  }

  private micLost(session: Session, why: "muted" | "ended") {
    if (session.ended) return;
    if (!session.micSuspended) {
      session.micSuspended = true;
      this.trace.record("mic.suspended", { why });
      this.render();
    }
    void this.recover(session);
  }

  /** The app went to the background and the OS took the mic: end the call. */
  private async suspendHidden(session: Session) {
    if (session.ended || session.ending) return;
    session.ending = true;
    // The server first, so the end is recorded even if the page freezes now.
    await this.deps.rpc.call("endCallsEverywhere", { nonce: session.nonce, reason: "background" }).catch(() => undefined);
    this.deps.toast(`${this.deps.agentName()}: call ended because the app went to the background.`);
    this.teardown(session, { reason: "background", server: false, record: "call.suspended" });
  }

  /** Swap in a fresh mic track without renegotiating. Only while visible. */
  private async recover(session: Session) {
    if (session.ended || session.ending || session.recovering || !this.deps.visible()) return;
    session.recovering = true;
    try {
      const stream = await acquireMic(this.deps.media(), this.timing.micTimeoutMs);
      const track = stream.getAudioTracks()[0];
      if (session.ended || !track) {
        stream.getTracks().forEach((item) => item.stop());
        return;
      }
      await session.sender?.replaceTrack(track);
      // Detach first, so the old track's end does not start another recovery.
      session.detachTrack?.();
      const old = session.stream;
      session.stream = stream;
      this.useTrack(session, track);
      old?.getTracks().forEach((item) => item.stop());
      session.micSuspended = false;
      this.trace.record("mic.recovered", { label: track.label });
      this.render();
    } catch (cause) {
      this.trace.record("error", { stage: "mic.recover", message: messageOf(cause) });
    } finally {
      session.recovering = false;
    }
  }

  // --- Stopping and presence --------------------------------------------------

  private teardown(session: Session, how: Teardown) {
    if (session.ended) return;
    session.ended = true;
    if (this.session === session) this.session = null;
    if (how.server) {
      void this.deps.rpc.call("endCallsEverywhere", { nonce: session.nonce, reason: how.reason }).catch(() => undefined);
    }
    if (session.heartbeat) clearInterval(session.heartbeat);
    this.notices.clear();
    session.detachTrack?.();
    try {
      session.channel?.close();
    } catch {
      // Already closed.
    }
    try {
      session.pc?.close();
    } catch {
      // Already closed.
    }
    session.stream?.getTracks().forEach((track) => track.stop());
    session.track?.stop();
    session.audio?.remove();
    if (session.startedAt !== null) this.deps.chimes.hangUp();
    this.publish({ nonce: session.nonce, phase: "idle", startedAt: null });
    // The last words go in before the end, so the call's summary sees them.
    this.transcript.flush();
    this.trace.record(how.record, { reason: how.reason, ...how.extra });
    void this.trace.end();
    this.render();
  }

  private announce(session: Session) {
    if (session.ended) return;
    this.publish({ nonce: session.nonce, phase: session.state, startedAt: session.startedAt });
  }

  private publish(presence: Pick<Presence, "nonce" | "phase" | "startedAt">) {
    void this.deps.rpc
      .call("announcePresence", { ...presence, clientId: this.deps.clientId, realmId: this.deps.realmId })
      .catch(() => undefined);
  }

  /**
   * Stop a call another realm owns. The first press relays a stop. A second
   * press soon after means the owner did not answer (a frozen webview), so the
   * server ends the call (SPEC §5.5).
   */
  private async stopMirror(mirror: Mirror) {
    const now = Date.now();
    const again = now - this.lastMirrorStop < this.timing.doubleStopMs;
    this.lastMirrorStop = now;
    if (again) {
      this.mirror.clear();
      await this.deps.rpc.call("endCallsEverywhere", { nonce: mirror.nonce, reason: "user" }).catch(() => undefined);
      return;
    }
    await this.deps.rpc.call("relayCommand", { command: "stop", nonce: mirror.nonce }).catch(() => undefined);
  }

  private render() {
    const session = this.session;
    const { work, outcome } = this.store.get();
    if (session) {
      this.store.set({
        state: session.state,
        owner: "self",
        nonce: session.nonce,
        callId: session.callId,
        startedAt: session.startedAt,
        activity: session.activity,
        micSuspended: session.micSuspended,
        work,
        outcome,
      });
      return;
    }
    const mirror = this.mirror.current;
    if (mirror) {
      this.store.set({ ...IDLE_CALL, state: mirror.phase, owner: "mirror", nonce: mirror.nonce, startedAt: mirror.startedAt });
      return;
    }
    this.store.set(IDLE_CALL);
  }
}
