// Advanced (SPEC §12.7): model choices, a read-only look at which setup values
// exist, and a reset for preferences.
import { useState } from "react";
import { REASONING_MODELS, SECRET_IDS, SETUP_LABELS, VOICE_MODELS } from "../../shared/constants.js";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { usePreferences, useSetupStatus } from "./data.js";
import { Group, Loading, Note, Row, selectClass } from "./layout.js";

const RECOMMENDED = REASONING_MODELS[0];

function Credentials() {
  const { status, error } = useSetupStatus();
  if (!status) return <Loading error={error} />;
  return (
    <div className="flex flex-col gap-1 py-3">
      <h4 className="text-sm font-medium text-foreground">Credentials</h4>
      <Note>BB stores each value as a secret file. It is never sent to the browser. Edit the values in the fields at the top of this page.</Note>
      <ul className="flex flex-col">
        {SECRET_IDS.map((id) => (
          <li key={id} className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-sm text-foreground">{SETUP_LABELS[id]}</span>
            <Badge variant={status.fields[id] ? "secondary" : "outline"}>{status.fields[id] ? "set" : "not set"}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AdvancedSection() {
  const { prefs, error, save, reset } = usePreferences();
  const [confirming, setConfirming] = useState(false);
  if (!prefs) return <Loading error={error} />;

  const listed = (known: readonly string[], current: string) => (known.includes(current) ? [...known] : [current, ...known]);

  return (
    <Group>
      <Row label="Voice model" htmlFor="dispatch-voice-model">
        <select id="dispatch-voice-model" className={selectClass} value={prefs.voiceModel} onChange={(event) => void save({ voiceModel: event.target.value })}>
          {listed(VOICE_MODELS, prefs.voiceModel).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Reasoning model" htmlFor="dispatch-reasoning-model" help="The model that plans and runs the agent's tools.">
        <select id="dispatch-reasoning-model" className={selectClass} value={prefs.reasoningModel} onChange={(event) => void save({ reasoningModel: event.target.value })}>
          {listed(REASONING_MODELS, prefs.reasoningModel).map((model) => (
            <option key={model} value={model}>
              {model === RECOMMENDED ? `${model} (recommended)` : model}
            </option>
          ))}
        </select>
      </Row>
      <Credentials />
      <Row label="Reset preferences" help="Puts every option on this page back to its default. Your setup values and instructions stay.">
        {confirming ? (
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                void reset().then(() => setConfirming(false));
              }}
            >
              Confirm reset
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Reset preferences
          </Button>
        )}
      </Row>
      {error ? <Note tone="error">{error}</Note> : null}
    </Group>
  );
}
