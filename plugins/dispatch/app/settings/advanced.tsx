// Advanced (SPEC §12.7): model choices and a reset for preferences.
import { useState } from "react";
import { REASONING_MODELS, VOICE_MODELS } from "../../shared/constants.js";
import { Button } from "../components/ui/button";
import { usePreferences } from "./data.js";
import { Group, Loading, Note, Row, SettingSelect } from "./layout.js";

const RECOMMENDED = REASONING_MODELS[0];

export function AdvancedSection() {
  const { prefs, error, save, reset } = usePreferences();
  const [confirming, setConfirming] = useState(false);
  if (!prefs) return <Loading error={error} />;

  const listed = (known: readonly string[], current: string) => (known.includes(current) ? [...known] : [current, ...known]);
  const voiceModels = listed(VOICE_MODELS, prefs.voiceModel);

  return (
    <Group>
      {voiceModels.length > 1 ? <Row label="Voice model" htmlFor="dispatch-voice-model">
        <SettingSelect id="dispatch-voice-model" label="Voice model" value={prefs.voiceModel} options={voiceModels.map((model) => ({ value: model, label: model }))} onValueChange={(voiceModel) => void save({ voiceModel })} />
      </Row> : null}
      <Row label="Reasoning model" htmlFor="dispatch-reasoning-model" help="Plans and runs the agent's tools.">
        <SettingSelect id="dispatch-reasoning-model" label="Reasoning model" value={prefs.reasoningModel} options={listed(REASONING_MODELS, prefs.reasoningModel).map((model) => ({ value: model, label: model === RECOMMENDED ? `${model} (recommended)` : model }))} onValueChange={(reasoningModel) => void save({ reasoningModel })} />
      </Row>
      <Row label="Reset preferences" help="Restore defaults. Setup values and instructions stay.">
        {confirming ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                void reset().then((ok) => { if (ok) setConfirming(false); });
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
