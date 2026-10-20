import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Presence, SetupStatus } from "@/shared/contract.js";
import { defaultPreferences } from "@/shared/constants.js";
import { CallController, type ControllerDeps } from "./call-controller.js";
import { IDLE_CALL, type CallSnapshot } from "./call-store.js";
import { createStore } from "./store.js";

// --- Fakes --------------------------------------------------------------------

class FakeTrack extends EventTarget {
  enabled = true;
  muted = false;
  readyState: "live" | "ended" = "live";
  stopped = false;
  constructor(readonly label: string) {
    super();
  }
  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
}

class FakeStream {
  constructor(readonly track: FakeTrack) {}
  getTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return [this.track];
  }
}

class FakeChannel extends EventTarget {
  readyState: "connecting" | "open" | "closed" = "open";
  sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = "closed";
  }
  /** Deliver a server event to the controller. */
  emit(event: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
  types() {
    return this.sent.map((event) => event.type);
  }
}

class FakeSender {
  track: FakeTrack;
  constructor(track: FakeTrack) {
    this.track = track;
  }
  replaceTrack = vi.fn(async (track: FakeTrack) => {
    this.track = track;
  });
}

class FakePeer extends EventTarget {
  iceGatheringState = "complete";
  connectionState = "new";
  iceConnectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  channel = new FakeChannel();
  sender: FakeSender | null = null;
  closed = false;
  addTrack(track: FakeTrack) {
    this.sender = new FakeSender(track);
    return this.sender;
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async setLocalDescription(offer: { type: string; sdp: string }) {
    this.localDescription = offer;
  }
  async setRemoteDescription(answer: { type: string; sdp: string }) {
    this.remote = answer;
  }
  close() {
    this.closed = true;
  }
}

const READY: SetupStatus = {
  fields: {} as SetupStatus["fields"],
  voice: { ready: true, missing: [] },
  phone: { ready: false, missing: [], webhooksPlugin: "absent" },
  needsConfiguration: false,
  reloadPending: false,
  version: "test",
};

type Rpc = ControllerDeps["rpc"];

function setup(options: { visible?: boolean; setup?: SetupStatus | null; runTool?: ControllerDeps["runTool"] } = {}) {
  const peers: FakePeer[] = [];
  const tracks: FakeTrack[] = [];
  const calls: Array<{ method: string; input: unknown }> = [];
  const order: string[] = [];
  let visible = options.visible ?? true;
  let callCount = 0;
  const rpc: Rpc = {
    call: vi.fn(async (method: string, input: unknown) => {
      calls.push({ method, input });
      order.push(method);
      if (method === "openCall") {
        callCount += 1;
        return { sdp: "answer-sdp", sessionId: `s${callCount}`, callId: `call-${callCount}` };
      }
      if (method === "endCallsEverywhere") return { stopped: 1 };
      return { ok: true };
    }) as unknown as Rpc["call"],
  };
  const media = {
    enumerateDevices: vi.fn(async () => [{ kind: "audioinput", deviceId: "mic", label: "Mic", groupId: "" }] as MediaDeviceInfo[]),
    getUserMedia: vi.fn(async () => {
      const track = new FakeTrack(`mic-${tracks.length + 1}`);
      tracks.push(track);
      return new FakeStream(track) as unknown as MediaStream;
    }),
  };
  const store = createStore<CallSnapshot>(IDLE_CALL);
  const toast = vi.fn();
  const chimes = { ready: vi.fn(), hangUp: vi.fn(() => order.push("chime")) };
  const deps: ControllerDeps = {
    rpc,
    createPeer: () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    media: () => media,
    createAudio: () => ({ play: vi.fn(async () => undefined), route: vi.fn(async () => false), remove: vi.fn() }),
    outputDeviceId: () => null,
    visible: () => visible,
    profile: { platform: "macOS", mobile: false, browser: "Chrome", displayMode: "browser", runtime: "browser", label: "desktop" },
    screen: () => ({ threadId: "t1", projectId: "p1", onNewThreadScreen: false }),
    prefs: () => defaultPreferences(),
    setup: () => (options.setup === undefined ? READY : options.setup),
    agentName: () => "Juno",
    runTool: options.runTool ?? (async () => "ok"),
    toast,
    openSettings: vi.fn(),
    chimes,
    clientId: "client-a",
    realmId: "realm-a",
    store,
  };
  const controller = new CallController(deps);
  return {
    controller,
    deps,
    store,
    toast,
    chimes,
    peers,
    tracks,
    calls,
    order,
    media,
    peer: () => peers.at(-1)!,
    setVisible: (next: boolean) => {
      visible = next;
    },
    of: (method: string) => calls.filter((call) => call.method === method).map((call) => call.input),
    traced: () =>
      calls
        .filter((call) => call.method === "traceAppend")
        .flatMap((call) => (call.input as { events: Array<{ kind: string; payload?: Record<string, unknown> }> }).events),
  };
}

/** Start a call and bring it live. */
async function live(rig: ReturnType<typeof setup>) {
  await rig.controller.toggle();
  rig.peer().channel.emit({ type: "session.started" });
  return rig.peer();
}

const other = (patch: Partial<Presence>): Presence => ({
  nonce: "n-other",
  phase: "live",
  startedAt: 1000,
  clientId: "client-b",
  realmId: "realm-b",
  ...patch,
});

/** Let promises and the trace queue run. Short of the heartbeat. */
const tick = () => vi.advanceTimersByTimeAsync(600);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Tests --------------------------------------------------------------------

describe("starting a call", () => {
  it("opens the call with the screen context and goes live on session.started", async () => {
    const rig = setup();
    await rig.controller.toggle();
    expect(rig.store.get()).toMatchObject({ state: "connecting", owner: "self", callId: "call-1" });
    const [open] = rig.of("openCall") as Array<Record<string, unknown>>;
    expect(open).toMatchObject({
      sdp: "offer-sdp",
      clientId: "client-a",
      realmId: "realm-a",
      context: { threadId: "t1", projectId: "p1", onNewThreadScreen: false, mobile: false, canNavigate: true, channel: "app" },
    });
    expect(rig.peer().remote).toEqual({ type: "answer", sdp: "answer-sdp" });

    rig.peer().channel.emit({ type: "session.started" });
    expect(rig.store.get()).toMatchObject({ state: "live", owner: "self" });
    expect(rig.store.get().startedAt).not.toBeNull();
    expect(rig.chimes.ready).toHaveBeenCalledOnce();
    expect(rig.of("announcePresence").at(-1)).toMatchObject({ phase: "live", realmId: "realm-a" });
  });

  it("shows the not-ready toast and does not start without a key", async () => {
    const rig = setup({ setup: { ...READY, voice: { ready: false, missing: ["OpenAI API key"] } } });
    await rig.controller.toggle();
    expect(rig.toast).toHaveBeenCalledWith("Juno needs an OpenAI API key. Open Dispatch settings.", expect.objectContaining({ action: expect.anything() }));
    expect(rig.of("openCall")).toHaveLength(0);
    expect(rig.store.get().state).toBe("idle");
  });

  it("a second start toggles to stop", async () => {
    const rig = setup();
    const peer = await live(rig);
    await rig.controller.toggle();
    expect(rig.store.get()).toEqual(IDLE_CALL);
    expect(peer.closed).toBe(true);
    expect(rig.tracks[0]!.stopped).toBe(true);
    expect(rig.of("endCallsEverywhere")).toEqual([{ nonce: rig.of("openCall").map((input) => (input as Presence).nonce)[0], reason: "user" }]);
    expect(rig.of("announcePresence").at(-1)).toMatchObject({ phase: "idle" });
    expect(rig.chimes.hangUp).toHaveBeenCalledOnce();
    await tick();
    expect(rig.traced().map((event) => event.kind)).toContain("call.stopped");
  });

  it("stopping twice is a no-op the second time", async () => {
    const rig = setup();
    await live(rig);
    await rig.controller.stop();
    await rig.controller.stop();
    expect(rig.of("endCallsEverywhere")).toHaveLength(1);
    expect(rig.chimes.hangUp).toHaveBeenCalledOnce();
  });

  it("cleans up, records an error and shows a toast when the server refuses", async () => {
    const rig = setup();
    (rig.deps.rpc.call as ReturnType<typeof vi.fn>).mockReset().mockImplementation(async (method: string, input: unknown) => {
      rig.calls.push({ method, input });
      if (method === "openCall") throw new Error("Voice service is down");
      return { ok: true };
    });
    await rig.controller.toggle();
    expect(rig.store.get().state).toBe("idle");
    expect(rig.peer().closed).toBe(true);
    expect(rig.tracks[0]!.stopped).toBe(true);
    expect(rig.toast).toHaveBeenCalledWith("Juno: Voice service is down", { tone: "error" });
    expect(rig.chimes.hangUp).not.toHaveBeenCalled();
  });

  it("wake starts only when no call runs", async () => {
    const rig = setup();
    await rig.controller.wake();
    await rig.controller.wake();
    expect(rig.of("openCall")).toHaveLength(1);
    expect(rig.store.get().state).toBe("connecting");
  });
});

describe("presence", () => {
  it("mirrors another realm's call, with its start time", () => {
    const rig = setup();
    rig.controller.onPresence(other({ phase: "muted", startedAt: 1234 }));
    expect(rig.store.get()).toMatchObject({ state: "muted", owner: "mirror", nonce: "n-other", startedAt: 1234 });
  });

  it("ignores its own echoes", () => {
    const rig = setup();
    rig.controller.onPresence(other({ realmId: "realm-a" }));
    expect(rig.store.get().state).toBe("idle");
  });

  it("ignores presence while it owns a call", async () => {
    const rig = setup();
    await live(rig);
    rig.controller.onPresence(other({}));
    expect(rig.store.get().owner).toBe("self");
  });

  it("drops a mirror that goes stale", () => {
    const rig = setup();
    rig.controller.onPresence(other({}));
    vi.advanceTimersByTime(14_000);
    expect(rig.store.get().owner).toBe("mirror");
    rig.controller.onPresence(other({}));
    vi.advanceTimersByTime(14_000);
    expect(rig.store.get().owner).toBe("mirror");
    vi.advanceTimersByTime(1_100);
    expect(rig.store.get()).toEqual(IDLE_CALL);
  });

  it("an idle presence for an older nonce does not clear a newer mirror", () => {
    const rig = setup();
    rig.controller.onPresence(other({ nonce: "n-new" }));
    rig.controller.onPresence(other({ nonce: "n-old", phase: "idle", startedAt: null }));
    expect(rig.store.get()).toMatchObject({ owner: "mirror", nonce: "n-new" });
    rig.controller.onPresence(other({ nonce: "n-new", phase: "idle", startedAt: null }));
    expect(rig.store.get()).toEqual(IDLE_CALL);
  });

  it("the owner publishes on a heartbeat and answers a ping", async () => {
    const rig = setup();
    await live(rig);
    const before = rig.of("announcePresence").length;
    vi.advanceTimersByTime(5_000);
    expect(rig.of("announcePresence").length).toBe(before + 1);
    rig.controller.onPresencePing();
    expect(rig.of("announcePresence").length).toBe(before + 2);
  });

  it("a mirror relays stop, and a second stop soon after ends the call on the server", async () => {
    const rig = setup();
    rig.controller.onPresence(other({}));
    await rig.controller.toggle();
    expect(rig.of("relayCommand")).toEqual([{ command: "stop", nonce: "n-other" }]);
    expect(rig.of("openCall")).toHaveLength(0);
    await rig.controller.toggle();
    expect(rig.of("endCallsEverywhere")).toEqual([{ nonce: "n-other", reason: "user" }]);
    expect(rig.store.get()).toEqual(IDLE_CALL);
  });

  it("a mirror relays mute with the mirrored nonce", async () => {
    const rig = setup();
    rig.controller.onPresence(other({}));
    await rig.controller.toggleMute();
    expect(rig.of("relayCommand")).toEqual([{ command: "mute", nonce: "n-other" }]);
  });
});

describe("relayed commands and call control", () => {
  it("a relayed mute or stop applies only for the matching nonce", async () => {
    const rig = setup();
    await live(rig);
    const nonce = rig.store.get().nonce!;
    rig.controller.onAgentCommand({ command: "mute", nonce: "someone-else" });
    expect(rig.store.get().state).toBe("live");
    rig.controller.onAgentCommand({ command: "mute", nonce });
    expect(rig.store.get().state).toBe("muted");
    expect(rig.tracks[0]!.enabled).toBe(false);
    rig.controller.onAgentCommand({ command: "unmute", nonce });
    expect(rig.tracks[0]!.enabled).toBe(true);
    rig.controller.onAgentCommand({ command: "stop", nonce: "someone-else" });
    expect(rig.store.get().state).toBe("live");
    rig.controller.onAgentCommand({ command: "stop", nonce });
    expect(rig.store.get().state).toBe("idle");
  });

  it("a call-control stop for a different nonce stops this call; its own nonce does not", async () => {
    const rig = setup();
    await live(rig);
    const nonce = rig.store.get().nonce!;
    rig.controller.onCallControl({ action: "stop", nonce, reason: "replaced" });
    expect(rig.store.get().state).toBe("live");
    rig.controller.onCallControl({ action: "stop", nonce: "newer", reason: "replaced" });
    expect(rig.store.get().state).toBe("idle");
    // The server already ended it.
    expect(rig.of("endCallsEverywhere")).toHaveLength(0);
  });

  it("a null-nonce call-control stops everything, mirrors included", () => {
    const rig = setup();
    rig.controller.onPresence(other({}));
    rig.controller.onCallControl({ action: "stop", nonce: null, reason: "ended" });
    expect(rig.store.get()).toEqual(IDLE_CALL);
  });
});

describe("microphone", () => {
  it("a mic mute while hidden ends the call, calling the server first", async () => {
    const rig = setup();
    await live(rig);
    const nonce = rig.store.get().nonce!;
    rig.setVisible(false);
    rig.tracks[0]!.dispatchEvent(new Event("mute"));
    await tick();
    expect(rig.of("endCallsEverywhere")).toEqual([{ nonce, reason: "background" }]);
    expect(rig.order.indexOf("endCallsEverywhere")).toBeLessThan(rig.order.indexOf("chime"));
    expect(rig.toast).toHaveBeenCalledWith("Juno: call ended because the app went to the background.");
    expect(rig.store.get().state).toBe("idle");
    expect(rig.traced().map((event) => event.kind)).toContain("call.suspended");
  });

  it("a visible mic loss recovers with a new track and keeps the mute state", async () => {
    const rig = setup();
    const peer = await live(rig);
    await rig.controller.setMuted(true);
    const first = rig.tracks[0]!;
    first.muted = true;
    first.dispatchEvent(new Event("mute"));
    await tick();
    const second = rig.tracks[1]!;
    expect(peer.sender!.replaceTrack).toHaveBeenCalledWith(second);
    expect(second.enabled).toBe(false);
    expect(first.stopped).toBe(true);
    expect(rig.store.get()).toMatchObject({ state: "muted", micSuspended: false });
    // The old track no longer drives recovery.
    first.dispatchEvent(new Event("ended"));
    await tick();
    expect(rig.tracks).toHaveLength(2);
  });

  it("does not recover while hidden, and recovers when the page is visible again", async () => {
    const rig = setup();
    await live(rig);
    rig.setVisible(false);
    rig.tracks[0]!.dispatchEvent(new Event("ended"));
    await tick();
    expect(rig.tracks).toHaveLength(1);
    expect(rig.store.get().micSuspended).toBe(true);
    rig.setVisible(true);
    rig.controller.onVisibility();
    await tick();
    expect(rig.tracks).toHaveLength(2);
    expect(rig.store.get().micSuspended).toBe(false);
  });
});

describe("tools and notices", () => {
  const functionCall = (callId: string) => ({ type: "response.output_item.done", item: { type: "function_call", call_id: callId, name: "get_context", arguments: "{}" } });

  it("a batch of tool calls gets its outputs and one continue", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const rig = setup({ runTool: () => new Promise<string>((resolve) => resolvers.push(resolve)) });
    const peer = await live(rig);
    peer.channel.emit({ type: "response.created" });
    peer.channel.emit(functionCall("c1"));
    peer.channel.emit(functionCall("c2"));
    peer.channel.emit({ type: "response.done" });
    resolvers[0]!("one");
    await tick();
    expect(peer.channel.types()).toEqual(["response.item.create"]);
    resolvers[1]!("two");
    await tick();
    expect(peer.channel.types()).toEqual(["response.item.create", "response.item.create", "response.create"]);
    // A late response.done does not send a second continue.
    peer.channel.emit({ type: "response.done" });
    await tick();
    expect(peer.channel.types().filter((type) => type === "response.create")).toHaveLength(1);
  });

  it("waits for the response to end before it continues", async () => {
    const rig = setup();
    const peer = await live(rig);
    peer.channel.emit({ type: "response.created" });
    peer.channel.emit(functionCall("c1"));
    await tick();
    expect(peer.channel.types()).toEqual(["response.item.create"]);
    peer.channel.emit({ type: "response.done" });
    await tick();
    expect(peer.channel.types()).toEqual(["response.item.create", "response.create"]);
  });

  it("batches thread notices and speaks them after the response ends", async () => {
    const rig = setup();
    const peer = await live(rig);
    peer.channel.emit({ type: "response.created" });
    const notice = { kind: "finished" as const, threadId: "t9", title: "Fix login", detail: "", projectId: "p1" };
    rig.controller.onThreadNotice(notice);
    rig.controller.onThreadNotice({ ...notice, threadId: "t8", title: "Docs" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(peer.channel.sent).toHaveLength(0);
    peer.channel.emit({ type: "response.done" });
    await tick();
    expect(peer.channel.types()).toEqual(["response.item.create", "response.create"]);
    expect(JSON.stringify(peer.channel.sent[0])).toContain("Fix login");
    expect(JSON.stringify(peer.channel.sent[0])).toContain("Docs");
    expect(rig.traced().map((event) => event.kind)).toContain("notice");
  });

  it("drops notices when announcements are off", async () => {
    const rig = setup();
    rig.deps.prefs = () => ({ ...defaultPreferences(), announcements: false });
    const peer = await live(rig);
    rig.controller.onThreadNotice({ kind: "finished", threadId: "t9", title: "Fix login", detail: "", projectId: "p1" });
    await tick();
    expect(peer.channel.sent).toHaveLength(0);
  });

  it("session.closed ends the call and records the billed seconds", async () => {
    const rig = setup();
    await live(rig);
    rig.peer().channel.emit({ type: "session.closed", reason: "timeout", usage: { seconds: 42 } });
    await tick();
    expect(rig.store.get().state).toBe("idle");
    const closed = rig.traced().find((event) => event.kind === "call.closed");
    expect(closed?.payload).toMatchObject({ reason: "timeout", seconds: 42 });
    expect(rig.of("endCallsEverywhere")).toHaveLength(0);
  });
});
