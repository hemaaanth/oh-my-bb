// Readiness comes from the server. This section never receives a setup value.
import { useSdk } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { PLUGIN_ID } from "../../shared/constants.js";
import { errorText, useSetupStatus } from "./data.js";
import { Group, Loading, Note, Row } from "./layout.js";

const shortLabel = (label: string): string => label.split(" — ").pop() ?? label;
const missingText = (missing: string[]): string => `Needs: ${missing.map(shortLabel).join(", ")}`;

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
      <div role="status" className="flex flex-wrap gap-x-6 gap-y-2 py-2 text-xs">
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">In-app voice</span>
          <span className={status.voice.ready ? "text-foreground" : "text-muted-foreground"}>{status.voice.ready ? "Ready" : "Not set up"}</span>
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">Phone calls</span>
          <span className={status.phone.ready ? "text-foreground" : "text-muted-foreground"}>{status.phone.ready ? "Ready" : "Not set up"}</span>
        </span>
      </div>
      {!status.voice.ready ? <div className="py-2"><Note>{missingText(status.voice.missing)}. Add the key in Configuration above.</Note></div> : null}
      <details className="py-2" open={status.phone.ready ? undefined : true}>
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Phone setup</summary>
        <div className="mt-2 flex flex-col gap-1">
          {!status.phone.ready ? <Note>{missingText(status.phone.missing)}. Phone calls are optional.</Note> : null}
          <Note>{status.phone.webhooksPlugin === "present" ? "Webhooks plugin found. Endpoint not verified." : "Webhooks plugin not found."}</Note>
          <a className="self-start text-xs text-foreground underline underline-offset-4" href="https://github.com/hemaaanth/oh-my-bb/blob/main/plugins/dispatch/docs/phone-calls.md" target="_blank" rel="noreferrer">Set up phone calls</a>
        </div>
      </details>
      {status.reloadPending ? (
        <Row label="Reload to apply" help="Your key is saved. Reload Dispatch to clear the setup banner.">
          <Button size="sm" onClick={() => void reload()} disabled={reloading}>
            {reloading ? "Reloading…" : "Reload to apply"}
          </Button>
          {reloadError ? <Note tone="error">{reloadError}</Note> : null}
        </Row>
      ) : null}
    </Group>
  );
}
