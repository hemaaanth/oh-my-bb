// Readiness (SPEC §12.2): one line per mode, from the server's SetupStatus.
// The section shows labels and yes/no only. It never receives a setup value.
import { useSdk } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { PLUGIN_ID } from "../../shared/constants.js";
import { errorText, useSetupStatus } from "./data.js";
import { Group, Loading, Note, Row } from "./layout.js";

/** "In-app voice — OpenAI API key" reads as "OpenAI API key" on a line that already names the mode. */
const shortLabel = (label: string): string => label.split(" — ").pop() ?? label;

function Verdict({ ready, missing }: { ready: boolean; missing: string[] }) {
  if (ready) return <span className="text-sm text-foreground">Ready</span>;
  return <span className="text-sm text-muted-foreground">Needs: {missing.map(shortLabel).join(", ")}</span>;
}

export function ReadinessSection() {
  const { status, error } = useSetupStatus();
  const sdk = useSdk();
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
      <Row label="In-app voice">
        <Verdict ready={status.voice.ready} missing={status.voice.missing} />
      </Row>
      <Row label="Phone calls">
        <Verdict ready={status.phone.ready} missing={status.phone.missing} />
      </Row>
      <Row label="Webhook route" help="Phone calls need the Webhooks plugin to hear when a call arrives. The steps are in docs/phone-calls.md.">
        <span className="text-sm text-muted-foreground">
          {status.phone.webhooksPlugin === "present" ? "Webhooks plugin found" : "Webhooks plugin not found"}
        </span>
      </Row>
      {status.reloadPending ? (
        <Row label="Reload pending" help="A key arrived after Dispatch loaded. Reload the plugin so voice can start.">
          <Button size="sm" onClick={() => void reload()} disabled={reloading}>
            {reloading ? "Reloading…" : "Reload to apply"}
          </Button>
          {reloadError ? <Note tone="error">{reloadError}</Note> : null}
        </Row>
      ) : null}
      <Note>
        <code>bb dispatch status</code> shows the same information in the terminal.
      </Note>
    </Group>
  );
}
