// The one thing the console cannot do alone is start an in-app call, because
// the call engine lives with the footer pet. That owner registers its start
// function here. Until it does, the "Wake" button is disabled.
import { useSyncExternalStore } from "react";

type StartCall = () => void | Promise<void>;

let startCall: StartCall | null = null;
const listeners = new Set<() => void>();

/** Register (or clear, with null) the function that starts an in-app call. Returns an unregister function. */
export function registerStartCall(fn: StartCall | null): () => void {
  startCall = fn;
  for (const listener of listeners) listener();
  return () => {
    if (startCall === fn) registerStartCall(null);
  };
}

export function useStartCall(): StartCall | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => startCall,
  );
}
