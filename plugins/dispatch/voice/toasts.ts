// Short messages for the user: not-ready, call failures, backgrounding.
// BB has no toast API for plugins, so Dispatch keeps its own list here and the
// bindings overlay draws it (voice/toaster.tsx).

import { randomId } from "./local.js";
import { createStore, useStore } from "./store.js";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  message: string;
  tone: "info" | "error";
  action?: ToastAction;
}

export interface ToastOptions {
  tone?: Toast["tone"];
  action?: ToastAction;
  /** Defaults to 6 s, or 9 s when the toast has an action. */
  durationMs?: number;
}

/** At most this many toasts show at once. The oldest goes first. */
const MAX_TOASTS = 3;

export const toastStore = createStore<readonly Toast[]>([]);
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function dismissToast(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  toastStore.set((current) => (current.some((toast) => toast.id === id) ? current.filter((toast) => toast.id !== id) : current));
}

export function showToast(message: string, options: ToastOptions = {}): string {
  const id = randomId();
  const toast: Toast = { id, message, tone: options.tone ?? "info", ...(options.action ? { action: options.action } : {}) };
  // The same message twice in a row replaces the first, so a held key does not stack copies.
  for (const item of toastStore.get()) if (item.message === message) dismissToast(item.id);
  toastStore.set((current) => [...current, toast]);
  for (const oldest of toastStore.get().slice(0, -MAX_TOASTS)) dismissToast(oldest.id);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), options.durationMs ?? (options.action ? 9000 : 6000)),
  );
  return id;
}

export const useToasts = () => useStore(toastStore);
