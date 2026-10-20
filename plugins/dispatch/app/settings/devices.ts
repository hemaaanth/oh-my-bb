// Audio devices for the Calls section. Browsers hide device names until the
// page has microphone permission, so this hook says whether names are real.
import { useCallback, useEffect, useRef, useState } from "react";

export type AudioDevice = { id: string; label: string };

export type Devices = {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  /** True once the browser has revealed real names. Until then every label is generic. */
  namesVisible: boolean;
  supported: boolean;
  refresh: () => Promise<void>;
  /** Ask for microphone permission once, then list the devices again. Returns an error text, or null. */
  grant: () => Promise<string | null>;
};

const mediaDevices = (): MediaDevices | undefined => (typeof navigator === "undefined" ? undefined : navigator.mediaDevices);

/** Can this browser route playback to a chosen speaker? */
export const canPickSpeaker = (): boolean => typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

export function describeMicError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was blocked. Allow it in the browser's site settings.";
  if (name === "NotFoundError") return "No microphone was found.";
  return "The microphone could not be opened.";
}

export function useAudioDevices(): Devices {
  const [list, setList] = useState<MediaDeviceInfo[]>([]);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const devices = mediaDevices();
    if (!devices?.enumerateDevices) return;
    try {
      const found = await devices.enumerateDevices();
      if (alive.current) setList(found);
    } catch {
      if (alive.current) setList([]);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const devices = mediaDevices();
    devices?.addEventListener?.("devicechange", refresh);
    return () => {
      alive.current = false;
      devices?.removeEventListener?.("devicechange", refresh);
    };
  }, [refresh]);

  const grant = useCallback(async (): Promise<string | null> => {
    const devices = mediaDevices();
    if (!devices?.getUserMedia) return "This browser cannot open the microphone.";
    try {
      const stream = await devices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      await refresh();
      return null;
    } catch (error) {
      return describeMicError(error);
    }
  }, [refresh]);

  const inputsRaw = list.filter((device) => device.kind === "audioinput");
  const outputsRaw = list.filter((device) => device.kind === "audiooutput");
  const namesVisible = inputsRaw.length > 0 && inputsRaw.every((device) => device.label !== "");
  const named = (devices: MediaDeviceInfo[], noun: string): AudioDevice[] =>
    devices
      .filter((device) => device.deviceId !== "default")
      .map((device, index) => ({ id: device.deviceId, label: namesVisible && device.label ? device.label : `${noun} ${index + 1}` }));

  return { inputs: named(inputsRaw, "Microphone"), outputs: named(outputsRaw, "Speaker"), namesVisible, supported: Boolean(mediaDevices()?.enumerateDevices), refresh, grant };
}

/** Measures microphone level for the "Test microphone" meter. */
export function useMicTest(deviceId: string | null) {
  const [level, setLevel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setLevel(null);
  }, []);

  const start = useCallback(async () => {
    stopRef.current?.();
    setError(null);
    const devices = mediaDevices();
    const Audio = typeof window === "undefined" ? undefined : window.AudioContext;
    if (!devices?.getUserMedia || !Audio) {
      setError("This browser cannot measure the microphone.");
      return;
    }
    try {
      const stream = await devices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      const context = new Audio();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let frame = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
        setLevel(Math.min(1, peak / 64));
        frame = requestAnimationFrame(tick);
      };
      tick();
      stopRef.current = () => {
        cancelAnimationFrame(frame);
        for (const track of stream.getTracks()) track.stop();
        void context.close();
      };
    } catch (cause) {
      setError(describeMicError(cause));
    }
  }, [deviceId]);

  useEffect(() => () => stopRef.current?.(), []);
  return { level, error, start, stop };
}
