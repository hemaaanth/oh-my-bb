import { useEffect, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { ShortcutSlot } from "../shared";

export function useShortcutSlots(slots: readonly ShortcutSlot[]) {
  const rpc = useRpc<typeof rpcContract>();
  const serialized = JSON.stringify(slots);
  const lastPublished = useRef<string | null>(null);
  const publisherId = useRef(crypto.randomUUID());
  const focusEpoch = useRef(document.hasFocus() ? Date.now() : 0);
  const sequence = useRef(0);

  useEffect(() => {
    const publish = (force = false) => {
      if (
        !force &&
        (!document.hasFocus() || document.visibilityState !== "visible")
      ) {
        return;
      }
      if (!force && lastPublished.current === serialized) return;
      if (force) focusEpoch.current = Date.now();
      lastPublished.current = serialized;
      sequence.current += 1;
      void rpc
        .call("publishShortcutSlots", {
          publisherId: publisherId.current,
          focusEpoch: focusEpoch.current,
          sequence: sequence.current,
          slots: JSON.parse(serialized),
        })
        .catch(() => {
          if (lastPublished.current === serialized) lastPublished.current = null;
        });
    };
    const publishFocusedView = () => {
      if (document.visibilityState === "visible") publish(true);
    };
    const publishVisibleView = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        publish(true);
      }
    };

    publish();
    window.addEventListener("focus", publishFocusedView);
    document.addEventListener("visibilitychange", publishVisibleView);
    return () => {
      window.removeEventListener("focus", publishFocusedView);
      document.removeEventListener("visibilitychange", publishVisibleView);
    };
  }, [rpc, serialized]);
}
