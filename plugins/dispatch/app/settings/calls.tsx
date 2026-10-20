// Calls (SPEC §12.5): microphone, speaker, shortcuts, announcements, and the
// mobile drawer behaviour. The mobile settings page reuses three of the rows.
import { useState } from "react";
import { LOCAL_KEYS, defaultPreferences } from "../../shared/constants.js";
import type { Preferences } from "../../shared/contract.js";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { usePreferences } from "./data.js";
import { canPickSpeaker, useAudioDevices, useMicTest } from "./devices.js";
import { readAudioChoice, useDeviceValue, writeAudioChoice } from "./device.js";
import { Group, Loading, Note, Row, SettingSelect } from "./layout.js";
import { ShortcutRow } from "./shortcuts.js";

/** The value of a select that means "the system default". */
const SYSTEM_DEFAULT = "dispatch-system-default";

function MicrophoneRow() {
  const devices = useAudioDevices();
  const [choice, setChoice] = useDeviceValue(LOCAL_KEYS.audio, readAudioChoice, writeAudioChoice);
  const [pick, setPick] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const preferred = pick ?? choice.inputDeviceId ?? SYSTEM_DEFAULT;
  const selected = devices.inputs.some((device) => device.id === preferred) ? preferred : SYSTEM_DEFAULT;
  const test = useMicTest(selected === SYSTEM_DEFAULT ? null : selected);

  const grant = async () => setMessage(await devices.grant());

  return (
    <Row label="Microphone" htmlFor="dispatch-mic" help={devices.namesVisible ? undefined : "Your browser hides microphone names until you allow access."}>
      <div className="flex items-center justify-end gap-2">
        <SettingSelect
          id="dispatch-mic"
          label="Microphone"
          value={selected}
          options={[{ value: SYSTEM_DEFAULT, label: "System default" }, ...devices.inputs.map((device) => ({ value: device.id, label: device.label }))]}
          onValueChange={(value) => {
            setPick(value);
            setSaved(false);
          }}
        />
        <Button
          size="sm"
          className="shrink-0"
          disabled={pick === null}
          onClick={() => {
            setChoice({ ...choice, inputDeviceId: selected === SYSTEM_DEFAULT ? null : selected });
            setPick(null);
            setSaved(true);
          }}
        >
          Save
        </Button>
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        {devices.namesVisible ? null : (
          <Button variant="outline" size="sm" className="px-2" onClick={() => void grant()}>
            Grant access
          </Button>
        )}
        <Button variant="ghost" size="sm" className="px-2" onClick={() => void devices.refresh()}>
          Refresh devices
        </Button>
        {test.level === null ? (
          <Button variant="ghost" size="sm" className="px-2" onClick={() => void test.start()}>
            Test microphone
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="px-2" onClick={test.stop}>
            Stop test
          </Button>
        )}
      </div>
      {test.level !== null ? (
        <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(test.level * 100)} className="h-2 w-full overflow-hidden rounded-full bg-state-hover sm:w-56">
          <div className="h-full bg-foreground transition-[width]" style={{ width: `${Math.round(test.level * 100)}%` }} />
        </div>
      ) : null}
      {saved ? <Note tone="ok">Saved for this device.</Note> : null}
      {message ?? test.error ? <Note tone="error">{message ?? test.error}</Note> : null}
    </Row>
  );
}

function SpeakerRow() {
  const devices = useAudioDevices();
  const [choice, setChoice] = useDeviceValue(LOCAL_KEYS.audio, readAudioChoice, writeAudioChoice);
  const supported = canPickSpeaker() && devices.outputs.length > 0;
  const selected = devices.outputs.find((device) => supported && device.id === choice.outputDeviceId)?.id ?? SYSTEM_DEFAULT;
  return (
    <Row label="Speaker" htmlFor="dispatch-speaker" help={supported ? undefined : "This browser plays sound through the system default speaker."}>
      <SettingSelect
        id="dispatch-speaker"
        label="Speaker"
        disabled={!supported}
        value={selected}
        options={[{ value: SYSTEM_DEFAULT, label: "System default" }, ...(supported ? devices.outputs.map((device) => ({ value: device.id, label: device.label })) : [])]}
        onValueChange={(value) => setChoice({ ...choice, outputDeviceId: value === SYSTEM_DEFAULT ? null : value })}
      />
    </Row>
  );
}

function AnnouncementsRow({ prefs, save }: { prefs: Preferences; save: (patch: Partial<Preferences>) => Promise<boolean> }) {
  return (
    <Row label="Announcements" inline help="The agent speaks a short notice when a thread finishes or fails.">
      <Switch aria-label="Announcements" checked={prefs.announcements} onCheckedChange={(announcements) => void save({ announcements })} />
    </Row>
  );
}

function DrawerRow({ prefs, save }: { prefs: Preferences; save: (patch: Partial<Preferences>) => Promise<boolean> }) {
  return (
    <Row label="Mobile drawer behaviour" htmlFor="dispatch-drawer" help="Reuse a view or add one per thread on mobile. Desktop always navigates.">
      <SettingSelect id="dispatch-drawer" label="Mobile drawer behaviour" value={prefs.mobileDrawerBehavior} options={[{ value: "reuse", label: "Reuse the current view" }, { value: "new", label: "Open a new view" }]} onValueChange={(value) => void save({ mobileDrawerBehavior: value as Preferences["mobileDrawerBehavior"] })} />
    </Row>
  );
}

export function CallsSection() {
  const { prefs, error, save } = usePreferences();
  if (!prefs) return <Loading error={error} />;
  const defaults = defaultPreferences().hotkeys;
  const saveHotkey = (action: "toggle" | "mute") => (combo: string) => save({ hotkeys: { ...prefs.hotkeys, [action]: combo } });
  return (
    <Group>
      <MicrophoneRow />
      <SpeakerRow />
      <ShortcutRow
        label="Start or stop a call"
        help="Works anywhere in BB."
        combo={prefs.hotkeys.toggle}
        defaultCombo={defaults.toggle}
        otherCombo={prefs.hotkeys.mute}
        onSave={saveHotkey("toggle")}
      />
      <ShortcutRow label="Mute or unmute" help="Works while a call is live." combo={prefs.hotkeys.mute} defaultCombo={defaults.mute} otherCombo={prefs.hotkeys.toggle} onSave={saveHotkey("mute")} />
      <AnnouncementsRow prefs={prefs} save={save} />
      <DrawerRow prefs={prefs} save={save} />
      {error ? <Note tone="error">{error}</Note> : null}
    </Group>
  );
}

/** The Dispatch section on BB's mobile settings page: microphone, announcements, drawer. */
export function MobileSection() {
  const { prefs, error, save } = usePreferences();
  if (!prefs) return <Loading error={error} />;
  return (
    <Group>
      <MicrophoneRow />
      <AnnouncementsRow prefs={prefs} save={save} />
      <DrawerRow prefs={prefs} save={save} />
      {error ? <Note tone="error">{error}</Note> : null}
    </Group>
  );
}
