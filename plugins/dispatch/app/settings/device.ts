// Device-local settings (CONTRACTS §4.4). They live in localStorage under the
// dispatch.* keys, and the `storage` event keeps other tabs on this device in step.
// Server preferences are never copied here.
import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_KEYS } from "../../shared/constants.js";

export type AudioChoice = { inputDeviceId: string | null; outputDeviceId: string | null };
const NO_AUDIO: AudioChoice = { inputDeviceId: null, outputDeviceId: null };

const store = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function readAudioChoice(): AudioChoice {
  try {
    const parsed = JSON.parse(store()?.getItem(LOCAL_KEYS.audio) ?? "null") as Partial<AudioChoice> | null;
    const pick = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
    return { inputDeviceId: pick(parsed?.inputDeviceId), outputDeviceId: pick(parsed?.outputDeviceId) };
  } catch {
    return NO_AUDIO;
  }
}

export function writeAudioChoice(choice: AudioChoice): void {
  store()?.setItem(LOCAL_KEYS.audio, JSON.stringify(choice));
}

/** The pointer ghost is on unless the key holds "off". */
export const readPointerGhost = (): boolean => store()?.getItem(LOCAL_KEYS.pointerGhost) !== "off";

export function writePointerGhost(enabled: boolean): void {
  if (enabled) store()?.removeItem(LOCAL_KEYS.pointerGhost);
  else store()?.setItem(LOCAL_KEYS.pointerGhost, "off");
}

/**
 * A device-local value with a setter. The setter writes storage and updates this
 * tab. The value re-reads when another tab changes the key.
 */
export function useDeviceValue<T>(key: string, read: () => T, write: (next: T) => void): [T, (next: T) => void] {
  const readRef = useRef(read);
  const writeRef = useRef(write);
  readRef.current = read;
  writeRef.current = write;
  const [value, setValue] = useState(read);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) setValue(readRef.current());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);
  const set = useCallback((next: T) => {
    writeRef.current(next);
    setValue(next);
  }, []);
  return [value, set];
}
