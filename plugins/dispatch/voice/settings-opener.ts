// Toast actions use the console navigation installed by the bindings overlay.

let fallback: (() => void) | null = null;


/** The bindings overlay sets this from BB navigation. */
export function setSettingsFallback(open: (() => void) | null) {
  fallback = open;
}

export function openDispatchSettings() {
  fallback?.();
}
