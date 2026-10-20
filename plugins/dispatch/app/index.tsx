// Dispatch app registrations. Owned by P2, who replaces the inert
// placeholders below. P4 owns the settings sections and the console body, and
// this file only calls into them. Every slot is registered here at P0 so a
// load check sees the full surface.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ConsolePanel } from "./console/index.js";
import { COMMANDS, COMPOSER, CONTENT_SCRIPTS, ICON, NAV_PANEL, OVERLAYS, SIDEBAR_FOOTER_PET, VIEWS_PANEL_ACTION, VIEWS_TAB } from "./ids.js";
import { registerSettingsSections } from "./settings/index.js";

const Nothing = () => null;
const NotBuilt = () => <p className="p-4 text-sm text-muted-foreground">Not built yet.</p>;

export default definePluginApp((app) => {
  // Footer pet (SPEC §7).
  app.experimental_sidebarFooter.register({ id: SIDEBAR_FOOTER_PET, kind: "action", label: "Dispatch", icon: ICON, onActivate() {} });

  // Pointer ghost (SPEC §8) and the invisible fallback bindings (SPEC §6.3).
  app.slots.experimental_appOverlay({ id: OVERLAYS.pointerGhost, component: Nothing });
  app.slots.experimental_appOverlay({ id: OVERLAYS.bindings, component: Nothing });

  // Call controls in the composer (SPEC §6).
  app.composer.customize({ id: COMPOSER.customization, actions: [{ id: COMPOSER.callControls, component: Nothing }] });

  // Console and the mobile drawer (SPEC §9, §13).
  app.slots.navPanel({
    ...NAV_PANEL,
    icon: ICON,
    component: ConsolePanel,
    fixedTabs: [{ ...VIEWS_TAB, icon: ICON, layout: "flush", component: NotBuilt }],
    experimental_useBadge: () => null,
  });
  app.slots.threadPanelAction({ ...VIEWS_PANEL_ACTION, icon: ICON, layout: "flush", component: NotBuilt });

  // Palette commands (SPEC §6.5).
  app.commands.register({ id: COMMANDS.toggleCall, title: "Dispatch: start or stop voice", isAvailable: () => false, run() {} });
  app.commands.register({ id: COMMANDS.toggleMute, title: "Dispatch: mute or unmute", isAvailable: () => false, run() {} });
  app.commands.register({ id: COMMANDS.callPhone, title: "Dispatch: call my phone", isAvailable: () => false, run() {} });

  // Hotkeys and call lifecycle (SPEC §6.6).
  app.contentScripts.register({ id: CONTENT_SCRIPTS.hotkeys, mount() {} });

  registerSettingsSections(app);
});
