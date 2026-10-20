// Gets a microphone track for a call (SPEC §5.2 step 5, §5.6 recovery). Uses
// the saved input device while it is present. When no input device exists yet
// (a headset still pairing), it waits for one. Everything shares one timeout.

import { micConstraints, pickDevice, readAudioChoice } from "./audio-devices.js";

export const MIC_TIMEOUT_MS = 10_000;

export class MicError extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "denied" | "missing" | "failed",
  ) {
    super(message);
    this.name = "MicError";
  }
}

type Devices = Pick<MediaDevices, "getUserMedia" | "enumerateDevices"> & Partial<Pick<MediaDevices, "addEventListener" | "removeEventListener">>;

function hasInput(devices: readonly MediaDeviceInfo[]) {
  return devices.some((device) => device.kind === "audioinput");
}

/** Resolves when an input device appears, or false at the deadline. */
async function waitForInput(media: Devices, deadline: number): Promise<MediaDeviceInfo[] | null> {
  let devices = await media.enumerateDevices();
  while (!hasInput(devices)) {
    const left = deadline - Date.now();
    if (left <= 0 || !media.addEventListener) return null;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        media.removeEventListener?.("devicechange", done);
        resolve();
      };
      const timer = setTimeout(done, left);
      media.addEventListener?.("devicechange", done);
    });
    devices = await media.enumerateDevices();
  }
  return devices;
}

function explain(error: unknown): MicError {
  if (error instanceof MicError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return new MicError("Microphone access was denied.", "denied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new MicError("No microphone was found.", "missing");
  return new MicError(error instanceof Error && error.message ? `The microphone failed: ${error.message}` : "The microphone failed.", "failed");
}

export async function acquireMic(media: Devices | undefined, timeoutMs = MIC_TIMEOUT_MS): Promise<MediaStream> {
  if (!media) throw new MicError("This browser has no microphone access.", "missing");
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MicError("The microphone did not start in time.", "timeout")), timeoutMs);
  });
  const attempt = (async () => {
    const devices = await waitForInput(media, deadline);
    if (!devices) throw new MicError("No microphone was found.", "missing");
    const deviceId = pickDevice(devices, "audioinput", readAudioChoice().inputDeviceId);
    return media.getUserMedia({ audio: micConstraints(deviceId) });
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } catch (error) {
    // A late stream from the losing branch must not keep the mic on.
    void attempt.then((stream) => stream.getTracks().forEach((track) => track.stop())).catch(() => undefined);
    throw explain(error);
  } finally {
    clearTimeout(timer);
  }
}
