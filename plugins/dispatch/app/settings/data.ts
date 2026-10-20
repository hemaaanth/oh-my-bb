// Shared data hooks for the settings sections. Each hook reads once on mount,
// then follows its realtime channel. The channel payload is the full object, so
// nothing is polled and nothing is fetched again.
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { CHANNELS } from "../../shared/constants.js";
import type { Preferences, RpcContract, SetupStatus } from "../../shared/contract.js";

export const errorText = (error: unknown): string => (error instanceof Error && error.message ? error.message : "Something went wrong.");

/** Keeps the newest value in a ref so effects can read it without re-running. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useSetupStatus() {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pushed = useRef(false);

  useEffect(() => {
    let active = true;
    rpcRef.current
      .call("setupStatus", {})
      .then((value) => {
        if (active && !pushed.current) setStatus(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [rpcRef]);

  useRealtime(CHANNELS.setupUpdated, (payload) => {
    pushed.current = true;
    setStatus(payload as SetupStatus);
  });
  return { status, error };
}

export function usePreferences() {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pushed = useRef(false);

  useEffect(() => {
    let active = true;
    rpcRef.current
      .call("preferencesRead", {})
      .then((value) => {
        if (active && !pushed.current) setPrefs(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [rpcRef]);

  useRealtime(CHANNELS.preferencesUpdated, (payload) => {
    pushed.current = true;
    setPrefs(payload as Preferences);
  });

  /** Write a patch. The server returns the normalised object, which replaces the local copy. */
  const save = useCallback(
    async (patch: Partial<Preferences>): Promise<boolean> => {
      try {
        setPrefs(await rpcRef.current.call("preferencesWrite", patch));
        setError(null);
        return true;
      } catch (cause) {
        setError(errorText(cause));
        return false;
      }
    },
    [rpcRef],
  );

  const reset = useCallback(async (): Promise<boolean> => {
    try {
      setPrefs(await rpcRef.current.call("preferencesReset", {}));
      setError(null);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    }
  }, [rpcRef]);

  return { prefs, error, save, reset };
}
