// Device-local values in localStorage (CONTRACTS §4.4): the client id, the
// audio devices and the pointer ghost switch. Each read is guarded, because
// private mode and sandboxed webviews can refuse storage.

import { LOCAL_KEYS } from "@/shared/constants.js";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readLocal(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, value);
  } catch {
    // A full quota or private mode: the value lasts for this page only.
  }
}

/** Run `listener` when another tab on this device changes `key`. */
export function onLocalChange(key: string, listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener();
  };
  window.addEventListener("storage", handle);
  return () => window.removeEventListener("storage", handle);
}

export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let fallbackClientId: string | null = null;

/** Stable per browser or device. Survives reloads (SPEC §4). */
export function clientId(): string {
  const saved = readLocal(LOCAL_KEYS.clientId);
  if (saved) return saved;
  const next = fallbackClientId ?? randomId();
  writeLocal(LOCAL_KEYS.clientId, next);
  // If storage refused the write, keep one id for the life of the page.
  fallbackClientId = next;
  return next;
}

/** New on every load, so two windows of one browser are two realms. */
export const REALM_ID = randomId();

/** The pointer ghost is on unless the key holds "off". */
export const pointerGhostEnabled = () => readLocal(LOCAL_KEYS.pointerGhost) !== "off";
