// Readiness comes from the server. This section never receives a setup value.
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { PLUGIN_ID } from "../../shared/constants.js";
import { errorText, useSetupStatus } from "./data.js";
import { NAV_PANEL } from "../ids.js";
import { Group, Loading, Note, Row } from "./layout.js";

const missingText = (missing: string[]): string => `Needs: ${missing.join(", ")}`;

export function ReadinessSection({ showSetupLink = true }: { showSetupLink?: boolean } = {}) {
  const { status, error } = useSetupStatus();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  if (!status) return <Loading error={error} />;

  const reload = async () => {
    setReloading(true);
    setReloadError(null);
    try {
      await sdk.plugins.reload({ pluginId: PLUGIN_ID });
    } catch (cause) {
      setReloadError(errorText(cause));
    } finally {
      setReloading(false);
    }
  };

  return (
    <Group>
      <div role="status" className="flex flex-wrap gap-x-6 gap-y-2 py-3 text-xs">
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">In-app voice</span>
          <span className={status.voice.ready ? "text-foreground" : "text-muted-foreground"}>{status.voice.ready ? "Ready" : "Not set up"}</span>
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">Phone calls</span>
          <span className={status.phone.ready ? "text-foreground" : "text-muted-foreground"}>{status.phone.ready ? "Ready" : "Not set up"}</span>
        </span>
      </div>
      {!status.voice.ready ? <div className="py-3"><Note>{missingText(status.voice.missing)}. Add the key in Configuration.</Note></div> : null}
      {!status.phone.ready ? <div className="py-3"><Note>{missingText(status.phone.missing)}. Phone calls are optional.</Note></div> : null}
      {showSetupLink && (!status.voice.ready || !status.phone.ready) ? (
        <Row label="Setup needed" help="In-app voice and phone setup.">
          <Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel(NAV_PANEL.path, { subPath: "setup" })}>Open setup guide</Button>
        </Row>
      ) : null}
      {status.reloadPending ? (
        <Row label="Reload to apply" help="Apply your saved OpenAI key.">
          <Button size="sm" onClick={() => void reload()} disabled={reloading}>
            {reloading ? "Reloading…" : "Reload to apply"}
          </Button>
          {reloadError ? <Note tone="error">{reloadError}</Note> : null}
        </Row>
      ) : null}
    </Group>
  );
}
