import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";

/**
 * Row actions keyed by thread id. The sidebar provides one object that never
 * changes identity, so memoized rows do not re-render when the host hands the
 * sidebar new action objects or callbacks.
 */
export interface ThreadRowActions {
  tasksEnabled: boolean;
  open: (threadId: string, split: boolean) => void;
  rename: (threadId: string, title: string) => Promise<void>;
  setLater: (threadId: string, later: boolean) => void;
  toggleChildren: (threadId: string) => void;
}

export const ThreadRowActionsContext = createContext<ThreadRowActions | null>(
  null,
);

export function useThreadRowActions(): ThreadRowActions {
  const actions = useContext(ThreadRowActionsContext);
  if (!actions) throw new Error("ThreadRowActionsContext is not provided");
  return actions;
}

/** A callback with a fixed identity that always runs the latest `callback`. */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
