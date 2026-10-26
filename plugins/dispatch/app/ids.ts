// Stable ids for every app registration. Owned by P0. Packages read these so
// that a link, a test, or a settings jump never spells an id by hand.

/** Declared in package.json `bb.branding.experimental_icons`. */
export const ICON = "dispatch/dispatch";

export const NAV_PANEL = { id: "console", title: "Dispatch", path: "console" } as const;
/** Mobile drawer views (SPEC §9.1): a fixed tab on the console panel and a thread panel action. */
export const VIEWS_TAB = { panelId: NAV_PANEL.id, id: "views", title: "Views" } as const;
export const VIEWS_PANEL_ACTION = { id: "views", title: "Views" } as const;

export const SIDEBAR_FOOTER_PET = "pet";
export const OVERLAYS = { pointerGhost: "pointer-ghost", bindings: "bindings", callStatus: "call-status" } as const;
export const COMPOSER = { customization: "dispatch", hook: "hook" } as const;
export const CONTENT_SCRIPTS = { hotkeys: "hotkeys" } as const;

/** Palette commands (SPEC §6.5). */
export const COMMANDS = { toggleCall: "toggle-call", toggleMute: "toggle-mute", callPhone: "call-phone" } as const;

/** Plugin-owned sections follow BB's native Configuration form. */
export const SETTINGS_SECTIONS = [
  { id: "readiness" },
  { id: "agent" },
  { id: "tools" },
  { id: "appearance" },
  { id: "calls" },
  { id: "advanced" },
  { id: "more" },
  { id: "integrations" },
] as const;
export const MOBILE_SETTINGS_SECTION = { id: "mobile", title: "Dispatch" } as const;
