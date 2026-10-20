// Dispatch app registrations. P2 owns the call surfaces here; the settings
// sections and the console body belong to P4, and this file only calls into
// them.
import { definePluginApp, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { BindingsOverlay } from "@/voice/bindings-overlay.js";
import { isCallActive, callStore } from "@/voice/call-store.js";
import { deviceProfile } from "@/voice/device-profile.js";
import { callMyPhone, toggleCall, toggleMute } from "@/voice/engine.js";
import { matchesKeydown } from "@/voice/hotkeys.js";
import { prefsStore } from "@/voice/preferences.js";
import { rememberSettingsOpener } from "@/voice/settings-opener.js";
import "./app.css";
import { ComposerCallControls } from "./composer-controls.js";
import { ConsolePanel, useConsoleBadge } from "./console/index.js";
import { ViewsDrawer } from "./drawer/views-drawer.js";
import { COMMANDS, COMPOSER, CONTENT_SCRIPTS, ICON, NAV_PANEL, OVERLAYS, SIDEBAR_FOOTER_PET, VIEWS_PANEL_ACTION, VIEWS_TAB } from "./ids.js";
import { PET_ICON, PetIcon, petMenuJustOpened } from "./pet/pet.js";
import { PointerGhostOverlay } from "./pointer-ghost/overlay.js";
import { registerSettingsSections } from "./settings/index.js";

/** The console reads `subPath` for the calls list or one call's transcript. */
const Console = ({ subPath }: PluginNavPanelProps) => <ConsolePanel subPath={subPath} />;

/** Run the saved shortcuts (SPEC §6.6). A recorder or another handler that took the key wins. */
function onHotkey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat) return;
  const { hotkeys } = prefsStore.get();
  const { platform } = deviceProfile();
  if (matchesKeydown(hotkeys.toggle, event, platform)) {
    event.preventDefault();
    void toggleCall();
  } else if (matchesKeydown(hotkeys.mute, event, platform) && isCallActive(callStore.get())) {
    event.preventDefault();
    void toggleMute();
  }
}

export default definePluginApp((app) => {
  // Footer pet (SPEC §7). The icon is the live pet; the button toggles the call.
  app.experimental_icons.register({ name: PET_ICON, component: PetIcon });
  app.experimental_sidebarFooter.register({
    id: SIDEBAR_FOOTER_PET,
    kind: "action",
    label: "Dispatch",
    icon: PET_ICON,
    onActivate(context) {
      rememberSettingsOpener(context.openPluginDetails);
      // The release that ends a long press is not a tap.
      if (petMenuJustOpened()) return;
      void toggleCall();
    },
  });

  // Pointer ghost (SPEC §8) and the invisible fallback bindings (SPEC §6.3).
  app.slots.experimental_appOverlay({ id: OVERLAYS.pointerGhost, component: PointerGhostOverlay });
  app.slots.experimental_appOverlay({ id: OVERLAYS.bindings, component: BindingsOverlay });

  // Call controls in the composer (SPEC §6.1).
  app.composer.customize({ id: COMPOSER.customization, actions: [{ id: COMPOSER.callControls, component: ComposerCallControls }] });

  // Console (SPEC §13) and, on phones, the drawer views (SPEC §9.1).
  const mobile = deviceProfile().mobile;
  app.slots.navPanel({
    ...NAV_PANEL,
    icon: ICON,
    component: Console,
    ...(mobile ? { fixedTabs: [{ ...VIEWS_TAB, icon: ICON, layout: "flush" as const, component: ViewsDrawer }] } : {}),
    experimental_useBadge: useConsoleBadge,
  });
  if (mobile) app.slots.threadPanelAction({ ...VIEWS_PANEL_ACTION, icon: ICON, layout: "flush", component: ViewsDrawer });

  // Palette commands (SPEC §6.5).
  app.commands.register({ id: COMMANDS.toggleCall, title: "Dispatch: start or stop voice", run: () => toggleCall() });
  app.commands.register({
    id: COMMANDS.toggleMute,
    title: "Dispatch: mute or unmute",
    isAvailable: () => isCallActive(callStore.get()),
    run: () => toggleMute(),
  });
  app.commands.register({ id: COMMANDS.callPhone, title: "Dispatch: call my phone", run: async () => void (await callMyPhone()) });

  // Keyboard shortcuts (SPEC §6.6).
  app.contentScripts.register({
    id: CONTENT_SCRIPTS.hotkeys,
    mount({ signal }) {
      window.addEventListener("keydown", onHotkey, { signal });
    },
  });

  registerSettingsSections(app);
});
