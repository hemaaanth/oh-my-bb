// Stable ids for every app registration. Owned by P0. Packages read these so
// that a link, a test, or a settings jump never spells an id by hand.

/** Declared in package.json `bb.branding.experimental_icons`. */
export const ICON = "dispatch/dispatch";

export const NAV_PANEL = { id: "console", title: "Dispatch", path: "console" } as const;
/** Mobile drawer views (SPEC §9.1): a fixed tab on the console panel and a thread panel action. */
export const VIEWS_TAB = { panelId: NAV_PANEL.id, id: "views", title: "Views" } as const;
export const VIEWS_PANEL_ACTION = { id: "views", title: "Views" } as const;

export const SIDEBAR_FOOTER_PET = "pet";
export const OVERLAYS = { pointerGhost: "pointer-ghost", bindings: "bindings" } as const;
export const COMPOSER = { customization: "dispatch", callControls: "call-controls" } as const;
export const CONTENT_SCRIPTS = { hotkeys: "hotkeys" } as const;

/** Palette commands (SPEC §6.5). */
export const COMMANDS = { toggleCall: "toggle-call", toggleMute: "toggle-mute", callPhone: "call-phone" } as const;

/** Settings sections in page order (SPEC §12), then the Mobile settings section. */
export const SETTINGS_SECTIONS = [
  { id: "readiness", title: "Readiness" },
  { id: "agent", title: "Agent" },
  { id: "appearance", title: "Appearance" },
  { id: "calls", title: "Calls" },
  { id: "tools", title: "Tools" },
  { id: "advanced", title: "Advanced" },
] as const;
export const MOBILE_SETTINGS_SECTION = { id: "mobile", title: "Dispatch" } as const;
