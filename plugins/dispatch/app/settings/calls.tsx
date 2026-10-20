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
import { Group, Loading, Note, Row, selectClass } from "./layout.js";
import { ShortcutRow } from "./shortcuts.js";

/** The value of a select that means "the system default". */
const SYSTEM_DEFAULT = "";

function MicrophoneRow() {
  const devices = useAudioDevices();
  const [choice, setChoice] = useDeviceValue(LOCAL_KEYS.audio, readAudioChoice, writeAudioChoice);
  const [pick, setPick] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const selected = pick ?? choice.inputDeviceId ?? SYSTEM_DEFAULT;
  const test = useMicTest(selected === SYSTEM_DEFAULT ? null : selected);

  const grant = async () => setMessage(await devices.grant());

  return (
    <Row label="Microphone" htmlFor="dispatch-mic" help={devices.namesVisible ? undefined : "Your browser hides microphone names until you allow access."}>
      <select
        id="dispatch-mic"
        className={selectClass}
        value={selected}
        onChange={(event) => {
          setPick(event.target.value);
          setSaved(false);
        }}
      >
        <option value={SYSTEM_DEFAULT}>System default</option>
        {devices.inputs.map((device) => (
          <option key={device.id} value={device.id}>
            {device.label}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap gap-2">
        {devices.namesVisible ? null : (
          <Button variant="outline" size="sm" onClick={() => void grant()}>
            Grant access
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void devices.refresh()}>
          Refresh devices
        </Button>
        {test.level === null ? (
          <Button variant="outline" size="sm" onClick={() => void test.start()}>
            Test microphone
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={test.stop}>
            Stop test
          </Button>
        )}
        <Button
          size="sm"
          disabled={pick === null}
          onClick={() => {
            setChoice({ ...choice, inputDeviceId: pick === SYSTEM_DEFAULT ? null : pick });
            setPick(null);
            setSaved(true);
          }}
        >
          Save
        </Button>
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
  return (
    <Row label="Speaker" htmlFor="dispatch-speaker" help={supported ? undefined : "This browser plays sound through the system default speaker."}>
      <select
        id="dispatch-speaker"
        className={selectClass}
        disabled={!supported}
        value={choice.outputDeviceId ?? SYSTEM_DEFAULT}
        onChange={(event) => setChoice({ ...choice, outputDeviceId: event.target.value === SYSTEM_DEFAULT ? null : event.target.value })}
      >
        <option value={SYSTEM_DEFAULT}>System default</option>
        {supported
          ? devices.outputs.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label}
              </option>
            ))
          : null}
      </select>
    </Row>
  );
}

function AnnouncementsRow({ prefs, save }: { prefs: Preferences; save: (patch: Partial<Preferences>) => Promise<boolean> }) {
  return (
    <Row label="Announcements" help="The agent speaks a short notice when a thread finishes or fails.">
      <Switch aria-label="Announcements" checked={prefs.announcements} onCheckedChange={(announcements) => void save({ announcements })} />
    </Row>
  );
}

function DrawerRow({ prefs, save }: { prefs: Preferences; save: (patch: Partial<Preferences>) => Promise<boolean> }) {
  return (
    <Row label="Mobile drawer behaviour" htmlFor="dispatch-drawer" help="On a phone, the agent can reuse the open view or add a new one for each thread. On desktop the agent always navigates.">
      <select id="dispatch-drawer" className={selectClass} value={prefs.mobileDrawerBehavior} onChange={(event) => void save({ mobileDrawerBehavior: event.target.value as Preferences["mobileDrawerBehavior"] })}>
        <option value="reuse">Reuse the current view</option>
        <option value="new">Open a new view</option>
      </select>
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
