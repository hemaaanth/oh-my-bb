// The server preferences and setup status, as plain stores. The bindings
// overlay feeds them once per realm: one read on mount, then every push on
// `preferences-updated` and `setup-updated`. The call controller reads them
// outside React; the pet, the controls and the drawer read them with hooks.

import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef } from "react";
import { CHANNELS, DEFAULT_AGENT_NAME, defaultPreferences } from "@/shared/constants.js";
import type { Preferences, RpcContract, SetupStatus } from "@/shared/contract.js";
import { createStore, useStore } from "./store.js";

export const prefsStore = createStore<Preferences>(defaultPreferences());
/** Null until the first read returns. */
export const setupStore = createStore<SetupStatus | null>(null);

export const agentNameOf = (prefs: Pick<Preferences, "agentName">) => prefs.agentName.trim() || DEFAULT_AGENT_NAME;
export const agentName = () => agentNameOf(prefsStore.get());

export const usePrefs = () => useStore(prefsStore);
export const useAgentName = () => agentNameOf(useStore(prefsStore));
export const useSetup = () => useStore(setupStore);

/** Mount once per realm. A push that lands before the first read wins over it. */
export function useFeedPreferences() {
  const rpc = useRpc<RpcContract>();
  const pushed = useRef({ prefs: false, setup: false });

  useEffect(() => {
    let active = true;
    rpc
      .call("preferencesRead", {})
      .then((value) => {
        if (active && !pushed.current.prefs) prefsStore.set(value);
      })
      // The defaults stay. The next push corrects them.
      .catch(() => undefined);
    rpc
      .call("setupStatus", {})
      .then((value) => {
        if (active && !pushed.current.setup) setupStore.set(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // One read per mount. The rpc client is stable for the plugin's life.
  }, []);

  useRealtime(CHANNELS.preferencesUpdated, (payload) => {
    pushed.current.prefs = true;
    prefsStore.set(payload as Preferences);
  });
  useRealtime(CHANNELS.setupUpdated, (payload) => {
    pushed.current.setup = true;
    setupStore.set(payload as SetupStatus);
  });
}
