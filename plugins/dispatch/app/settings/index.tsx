// BB owns Configuration and secret storage. Preferences starts the ordinary
// controls below that native form without duplicating or moving credentials.
import { UrlLink, useBbNavigate, type PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { MOBILE_SETTINGS_SECTION, NAV_PANEL, SETTINGS_SECTIONS } from "../ids.js";
import { AdvancedSection } from "./advanced.js";
import { AgentSection } from "./agent.js";
import { AppearanceSection } from "./appearance.js";
import { CallsSection, MobileSection } from "./calls.js";
import { ReadinessSection } from "./readiness.js";
import { ToolsSection } from "./tools.js";
import { Button } from "../components/ui/button";
import { useSetupStatus } from "./data.js";
import { Group, Note, Row, SettingsSection } from "./layout.js";

function MoreSection() {
  const navigate = useBbNavigate();
  return (
    <SettingsSection title="More">
      <Group>
        <Row label="Setup guide" help="In-app voice and phone setup.">
          <Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel(NAV_PANEL.path, { subPath: "setup" })}>Open setup guide</Button>
        </Row>
      </Group>
    </SettingsSection>
  );
}

function IntegrationsSection() {
  const { status } = useSetupStatus();
  if (status?.phone.webhooksPlugin !== "present") return null;
  return (
    <SettingsSection title="Oh My BB">
      <Group>
        <Row label="Webhooks" help="Enable or disable phone events in Webhooks.">
          <Button variant="outline" size="sm" asChild>
            <UrlLink href="/settings/plugins/webhooks">Manage in Webhooks</UrlLink>
          </Button>
        </Row>
      </Group>
    </SettingsSection>
  );
}

const COMPONENTS: Record<(typeof SETTINGS_SECTIONS)[number]["id"], ComponentType> = {
  readiness: () => (
    <SettingsSection title="Preferences">
      <Note>Voice, appearance and calls.</Note>
      <ReadinessSection />
    </SettingsSection>
  ),
  agent: AgentSection,
  tools: ToolsSection,
  appearance: AppearanceSection,
  calls: CallsSection,
  integrations: IntegrationsSection,
  advanced: () => <SettingsSection title="Advanced"><AdvancedSection /></SettingsSection>,
  more: MoreSection,
};

export function registerSettingsSections(app: PluginAppBuilder): void {
  for (const section of SETTINGS_SECTIONS) {
    app.slots.settingsSection({ ...section, component: COMPONENTS[section.id] });
  }
  app.slots.settingsSection({ ...MOBILE_SETTINGS_SECTION, experimental_page: "mobile", component: MobileSection });
}
