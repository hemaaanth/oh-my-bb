// Which microphone and speaker a call uses. The choice is device-local
// (`dispatch.audio`, CONTRACTS §4.4) because device ids differ per browser.
// A saved device that is gone falls back to the system default.

import { LOCAL_KEYS } from "@/shared/constants.js";
import { readLocal } from "./local.js";

export interface AudioChoice {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
}

export type AudioDevice = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

export function readAudioChoice(): AudioChoice {
  try {
    const parsed = JSON.parse(readLocal(LOCAL_KEYS.audio) ?? "null") as Partial<AudioChoice> | null;
    return { inputDeviceId: text(parsed?.inputDeviceId), outputDeviceId: text(parsed?.outputDeviceId) };
  } catch {
    return { inputDeviceId: null, outputDeviceId: null };
  }
}

/**
 * The device id to ask for, or null for the system default. The saved id wins
 * only while a device of that kind with that id is present.
 */
export function pickDevice(devices: readonly AudioDevice[], kind: "audioinput" | "audiooutput", savedId: string | null): string | null {
  if (!savedId || savedId === "default") return null;
  return devices.some((device) => device.kind === kind && device.deviceId === savedId) ? savedId : null;
}

/**
 * A name to show. Browsers hide labels until the page has microphone
 * permission, so an empty label becomes "Microphone 2" or "Speaker 1".
 */
export function deviceLabel(device: AudioDevice, index: number): string {
  if (device.label) return device.label;
  return `${device.kind === "audiooutput" ? "Speaker" : "Microphone"} ${index + 1}`;
}

/** Devices of one kind with display labels. */
export function listDevices(devices: readonly AudioDevice[], kind: "audioinput" | "audiooutput") {
  return devices
    .filter((device) => device.kind === kind && device.deviceId !== "")
    .map((device, index) => ({ id: device.deviceId, label: deviceLabel(device, index) }));
}

/** Audio constraints for `getUserMedia` with the chosen microphone. */
export function micConstraints(deviceId: string | null): MediaTrackConstraints {
  const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
}

/** Only some browsers let a page pick the speaker. */
export function canChooseSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}
