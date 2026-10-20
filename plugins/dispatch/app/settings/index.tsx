// Settings sections (SPEC §12). Owned by P4. The setup fields themselves are
// the host form from bb.settings.define; these sections never show a value.
// app/index.tsx calls registerSettingsSections once.
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { MOBILE_SETTINGS_SECTION, SETTINGS_SECTIONS } from "../ids.js";
import { AdvancedSection } from "./advanced.js";
import { AgentSection } from "./agent.js";
import { AppearanceSection } from "./appearance.js";
import { CallsSection, MobileSection } from "./calls.js";
import { ReadinessSection } from "./readiness.js";
import { ToolsSection } from "./tools.js";

const COMPONENTS: Record<(typeof SETTINGS_SECTIONS)[number]["id"], ComponentType> = {
  readiness: ReadinessSection,
  agent: AgentSection,
  appearance: AppearanceSection,
  calls: CallsSection,
  tools: ToolsSection,
  advanced: AdvancedSection,
};

export function registerSettingsSections(app: PluginAppBuilder): void {
  for (const section of SETTINGS_SECTIONS) {
    app.slots.settingsSection({ ...section, component: COMPONENTS[section.id] });
  }
  app.slots.settingsSection({ ...MOBILE_SETTINGS_SECTION, experimental_page: "mobile", component: MobileSection });
}
