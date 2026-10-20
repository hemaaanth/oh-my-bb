// WebRTC pieces of a call (SPEC §5.2 steps 6 and 9): the ICE wait, and the
// hidden audio element that plays the agent's voice.

export const ICE_TIMEOUT_MS = 2000;

/** Resolves when ICE gathering completes, or at the cap. Never rejects. */
export function waitForIce(pc: RTCPeerConnection, timeoutMs = ICE_TIMEOUT_MS): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export interface AudioSink {
  play(stream: MediaStream): Promise<void>;
  /** Resolves true when the browser took the speaker choice. */
  route(deviceId: string | null): Promise<boolean>;
  remove(): void;
}

type SinkElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * An audio element in the document. iOS plays a remote stream only from an
 * element that is in the page and allowed to play inline.
 */
export function createAudioSink(doc: Document = document): AudioSink {
  const element = doc.createElement("audio") as SinkElement;
  element.autoplay = true;
  element.setAttribute("playsinline", "");
  element.setAttribute("aria-hidden", "true");
  element.dataset.dispatchAudio = "";
  element.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none";
  doc.body.append(element);
  return {
    async play(stream) {
      element.srcObject = stream;
      // Autoplay rules can refuse; the call still works once the user taps.
      await element.play().catch(() => undefined);
    },
    async route(deviceId) {
      if (!deviceId || typeof element.setSinkId !== "function") return false;
      try {
        await element.setSinkId(deviceId);
        return true;
      } catch {
        return false;
      }
    },
    remove() {
      element.srcObject = null;
      element.remove();
    },
  };
}
