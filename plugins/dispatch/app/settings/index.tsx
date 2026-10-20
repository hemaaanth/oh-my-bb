// Settings sections (SPEC §12). Owned by P4. The setup fields themselves are
// the host form from bb.settings.define; these sections never show a value.
// P0 left inert placeholders. app/index.tsx calls registerSettingsSections once.
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import { MOBILE_SETTINGS_SECTION, SETTINGS_SECTIONS } from "../ids.js";

const NotBuilt = () => <p className="text-sm text-muted-foreground">Not built yet.</p>;

export function registerSettingsSections(app: PluginAppBuilder): void {
  for (const section of SETTINGS_SECTIONS) {
    app.slots.settingsSection({ ...section, component: NotBuilt });
  }
  app.slots.settingsSection({ ...MOBILE_SETTINGS_SECTION, experimental_page: "mobile", component: NotBuilt });
}
