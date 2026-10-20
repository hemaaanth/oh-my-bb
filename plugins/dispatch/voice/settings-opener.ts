// Opens Dispatch's settings page from a toast or the pet menu. Only the footer
// action's context can open the plugin's page in Tools, so the pet remembers
// that opener on its first activation. Before that, the Dispatch console opens
// instead.

let opener: (() => void) | null = null;
let fallback: (() => void) | null = null;

export function rememberSettingsOpener(open: () => void) {
  opener = open;
}

/** The bindings overlay sets this from BB navigation. */
export function setSettingsFallback(open: (() => void) | null) {
  fallback = open;
}

export function openDispatchSettings() {
  (opener ?? fallback)?.();
}
