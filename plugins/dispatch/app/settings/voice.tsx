// Voice settings in the Agent section: the voice list with samples, the voice
// style, and custom voices. GPT-Live has no speed or tone fields, so the style
// is a set of sentences in the voice prompt, and the copy says so.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CUSTOM_VOICE_EXAMPLE,
  defaultPreferences,
  CUSTOM_VOICE_NAME_MAX,
  CUSTOM_VOICE_PROMPT_MAX,
  VOICE_GROUPS,
  VOICE_NAMES,
  VOICE_OPTIONS,
  VOICE_STYLE_CHOICES,
  VOICE_STYLE_NOTES_MAX,
  type VoiceOption,
} from "../../shared/constants.js";
import type { Preferences, RpcContract, VoiceStyle } from "../../shared/contract.js";
import { hasBundledSample } from "../../shared/voice-samples.js";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { errorText, useLatest } from "./data.js";
import { Disclosure, Group, Note, Row, Segmented } from "./layout.js";

type Save = (patch: Partial<Preferences>) => Promise<boolean>;

export const SAMPLE_COST_NOTE = "Built-in samples are recordings in the default style. Your voices and Preview with this style use your OpenAI key, about 1¢ per new sample.";
export const SAMPLE_NO_KEY_NOTE = "Built-in samples are recordings in the default style. Add an OpenAI API key in Setup to hear your own voices, preview your style, and design voices.";
export const SAMPLE_PROGRESS = "Making a sample, about 10 seconds";
/** A cached sample plays well before this. Only a new sample shows the progress text. */
const PROGRESS_AFTER_MS = 400;

const DEFAULT_STYLE = defaultPreferences().voiceStyle;
const isDefaultStyle = (style: VoiceStyle) => (Object.keys(DEFAULT_STYLE) as Array<keyof VoiceStyle>).every((key) => style[key].trim() === DEFAULT_STYLE[key]);
export const STYLE_NOTE = "These are instructions in the voice prompt. The voice model follows them, but they are not exact controls.";

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Language, accent, and presentation, as far as the OpenAI voice table gives them. */
export function voiceDetail(voice: VoiceOption): string {
  if (voice.group !== "GPT-Live") return "Realtime voice";
  if (!voice.language) return "GPT-Live default";
  return [voice.region ? `${voice.language}, ${voice.region}` : voice.language, voice.presentation].filter(Boolean).join(" · ");
}

/** "default" is the list sample. "saved" is Preview with this style. */
type SampleStyle = "default" | "saved";

type Player = {
  /** The sample that is loading or playing. `slow` means a new sample is being made. */
  current: { voice: string; style: SampleStyle; playing: boolean; slow: boolean } | null;
  error: string | null;
  play: (voice: string, style: SampleStyle) => void;
  stop: () => void;
};

/** Plays one sample at a time. A new play stops the one before it. `premade` says which samples ship with Dispatch. */
function useSamplePlayer(premade: (voice: string, style: SampleStyle) => boolean): Player {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const premadeRef = useLatest(premade);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const turn = useRef(0);
  const slowTimer = useRef<number | undefined>(undefined);
  const [current, setCurrent] = useState<Player["current"]>(null);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    turn.current += 1;
    window.clearTimeout(slowTimer.current);
    audioRef.current?.pause();
    audioRef.current = null;
    setCurrent(null);
  }, []);

  const play = useCallback(
    (voice: string, style: SampleStyle) => {
      stop();
      const mine = turn.current;
      setError(null);
      setCurrent({ voice, style, playing: false, slow: false });
      if (!premadeRef.current(voice, style))
        slowTimer.current = window.setTimeout(() => {
          if (mine === turn.current) setCurrent((now) => (now && !now.playing ? { ...now, slow: true } : now));
        }, PROGRESS_AFTER_MS);
      rpcRef.current
        .call("voiceSample", { voice, style })
        .then(async ({ audio: base64, mime }) => {
          if (mine !== turn.current) return;
          window.clearTimeout(slowTimer.current);
          const audio = new Audio(`data:${mime};base64,${base64}`);
          audioRef.current = audio;
          audio.onended = () => {
            if (audioRef.current === audio) stop();
          };
          setCurrent({ voice, style, playing: true, slow: false });
          await audio.play();
        })
        .catch((cause: unknown) => {
          if (mine !== turn.current) return;
          stop();
          setError(errorText(cause));
        });
    },
    [premadeRef, rpcRef, stop],
  );

  useEffect(() => stop, [stop]);
  return { current, error, play, stop };
}

function PlayButton({ voice, label, player, canPlay }: { voice: string; label: string; player: Player; canPlay: boolean }) {
  const mine = player.current?.voice === voice && player.current.style === "default" ? player.current : null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={mine ? `Stop ${label}` : `Play ${label}`}
      disabled={!canPlay}
      onClick={() => (mine ? player.stop() : player.play(voice, "default"))}
    >
      <Icon name={mine && !mine.playing ? "Loading" : mine ? "Square" : "Play"} className={cn("size-3.5", mine && !mine.playing && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
    </Button>
  );
}

type ListedVoice = { name: string; label: string; detail: string };

function VoiceSection({ title, note, voices, chosen, onChoose, player, canPlay, onRemove }: {
  title: string;
  note?: string;
  voices: readonly ListedVoice[];
  chosen: string;
  onChoose: (voice: string) => void;
  player: Player;
  canPlay: (voice: string) => boolean;
  onRemove?: (voice: string) => void;
}) {
  if (voices.length === 0) return null;
  return (
    <section aria-label={title} className="pb-1">
      <h5 className="sticky top-0 z-10 bg-background px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{title}</h5>
      {note ? <p className="px-2 pb-1 text-xs text-muted-foreground">{note}</p> : null}
      <ul className="flex flex-col">
        {voices.map((voice) => (
          <li key={voice.name} className="flex items-center gap-1">
            <button
              type="button"
              aria-pressed={voice.name === chosen}
              onClick={() => onChoose(voice.name)}
              className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left hover:bg-state-hover aria-pressed:bg-state-active"
            >
              <span className="shrink-0 text-xs font-medium text-foreground">{voice.label}</span>
              <span className="truncate text-xs text-muted-foreground">{voice.detail}</span>
              {voice.name === chosen ? <Icon name="Check" className="ml-auto size-3.5 shrink-0" aria-hidden="true" /> : null}
            </button>
            <PlayButton voice={voice.name} label={voice.label} player={player} canPlay={canPlay(voice.name)} />
            {onRemove ? (
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onRemove(voice.name)}>
                Remove
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Shown while a new sample is being made, under the control that asked for it. */
function SampleProgress({ player, style }: { player: Player; style: SampleStyle }) {
  const slow = player.current?.slow === true && player.current.style === style;
  return (
    <p role="status" className="text-xs text-muted-foreground empty:hidden">
      {slow ? SAMPLE_PROGRESS : null}
    </p>
  );
}

function VoicePicker({ prefs, save, player, hasKey, canPlay, remove }: {
  prefs: Preferences;
  save: Save;
  player: Player;
  hasKey: boolean;
  canPlay: (voice: string) => boolean;
  remove: (id: string) => void;
}) {
  const custom = prefs.customVoices.map((voice) => ({ name: voice.id, label: voice.name, detail: "Your design" }));
  // A saved voice that left the list stays visible and in use.
  const unlisted =
    VOICE_NAMES.includes(prefs.voice) || prefs.customVoices.some((voice) => voice.id === prefs.voice)
      ? []
      : [{ name: prefs.voice, label: prefs.voice, detail: "No longer listed. Dispatch keeps using it." }];
  const chosen =
    [...unlisted, ...custom].find((voice) => voice.name === prefs.voice) ??
    VOICE_OPTIONS.map((voice) => ({ name: voice.name, label: voice.label, detail: voiceDetail(voice) })).find((voice) => voice.name === prefs.voice);
  const common = { chosen: prefs.voice, onChoose: (voice: string) => void save({ voice }), player, canPlay };

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="shrink-0 text-sm text-foreground">Voice</span>
        <span className="truncate text-xs text-muted-foreground">{chosen ? `${chosen.label} · ${chosen.detail}` : prefs.voice}</span>
      </div>
      <Note>{hasKey ? SAMPLE_COST_NOTE : SAMPLE_NO_KEY_NOTE}</Note>
      <div role="group" aria-label="Voice" className="max-h-80 overflow-y-auto overscroll-contain rounded-md border border-input bg-background px-1 pb-1">
        <VoiceSection title="Saved voice" voices={unlisted} {...common} />
        <VoiceSection title="Your voices" voices={custom} onRemove={remove} {...common} />
        {VOICE_GROUPS.map((group) => (
          <VoiceSection
            key={group}
            title={group}
            note={group === "GPT-Live" ? undefined : "Not in the GPT-Live voice table. GPT-Live may refuse them."}
            voices={VOICE_OPTIONS.filter((voice) => voice.group === group).map((voice) => ({ name: voice.name, label: voice.label, detail: voiceDetail(voice) }))}
            {...common}
          />
        ))}
      </div>
      <SampleProgress player={player} style="default" />
      {player.error ? <Note tone="error">{player.error}</Note> : null}
    </div>
  );
}

type Choice = Exclude<keyof VoiceStyle, "notes">;
const STYLE_ROWS: ReadonlyArray<{ key: Choice; label: string; help?: string }> = [
  { key: "pace", label: "Pace" },
  { key: "energy", label: "Energy" },
  { key: "expressiveness", label: "Expressiveness" },
  { key: "length", label: "Turn length" },
  { key: "backchannels", label: "Backchannels", help: "Short sounds like “mm-hm” while you talk." },
];

function StyleNotes({ saved, save }: { saved: string; save: (notes: string) => void }) {
  const [draft, setDraft] = useState(saved);
  const [shownSaved, setShownSaved] = useState(saved);
  if (saved !== shownSaved) {
    setShownSaved(saved);
    setDraft(saved);
  }
  return (
    <div className="flex flex-col gap-2 py-3">
      <label htmlFor="dispatch-style-notes" className="text-sm text-foreground">
        Style notes
      </label>
      <Textarea
        id="dispatch-style-notes"
        rows={2}
        value={draft}
        maxLength={VOICE_STYLE_NOTES_MAX}
        placeholder="For example: pause briefly before you give a number."
        onChange={(event) => setDraft(event.target.value.slice(0, VOICE_STYLE_NOTES_MAX))}
        onBlur={() => draft.trim() !== saved && save(draft)}
      />
      <span className="text-xs text-muted-foreground">
        {draft.length} / {VOICE_STYLE_NOTES_MAX}
      </span>
    </div>
  );
}

function VoiceStyleGroup({ prefs, save, player, canPreview }: { prefs: Preferences; save: Save; player: Player; canPreview: boolean }) {
  const style = prefs.voiceStyle;
  const change = (patch: Partial<VoiceStyle>) => void save({ voiceStyle: { ...style, ...patch } });
  const previewing = player.current?.style === "saved";
  return (
    <div className="py-3">
      <Group title="Voice style" note={STYLE_NOTE}>
        {STYLE_ROWS.map((row) => (
          <Row key={row.key} label={row.label} help={row.help}>
            <Segmented
              label={row.label}
              value={style[row.key]}
              options={VOICE_STYLE_CHOICES[row.key].map((choice) => ({ value: choice, label: capitalise(choice) }))}
              onChange={(choice) => change({ [row.key]: choice })}
            />
          </Row>
        ))}
        <StyleNotes saved={style.notes} save={(notes) => change({ notes })} />
        <div className="flex flex-col gap-2 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button variant="outline" size="sm" disabled={!canPreview && !previewing} onClick={() => (previewing ? player.stop() : player.play(prefs.voice, "saved"))}>
              {previewing ? "Stop preview" : "Preview with this style"}
            </Button>
            <span className="text-xs text-muted-foreground">Plays the chosen voice with these settings.</span>
          </div>
          <SampleProgress player={player} style="saved" />
        </div>
      </Group>
    </div>
  );
}

function DesignVoice({ canCreate, onCreated }: { canCreate: boolean; onCreated: (prefs: Preferences) => void }) {
  const rpc = useRpc<RpcContract>();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const prefs = await rpc.call("voiceCreate", { name, prompt });
      onCreated(prefs);
      setCreated(name.trim());
      setName("");
      setPrompt("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Disclosure label="Design a voice">
      <Note>OpenAI makes a new voice from your description. Creating it is free. Your key needs the api.voices.write permission. OpenAI keeps the voice; Remove only takes it off this list.</Note>
      <label htmlFor="dispatch-voice-name" className="text-xs font-medium text-foreground">
        Voice name
      </label>
      <Input id="dispatch-voice-name" value={name} maxLength={CUSTOM_VOICE_NAME_MAX} className="h-8 w-full max-w-56" onChange={(event) => setName(event.target.value)} />
      <label htmlFor="dispatch-voice-prompt" className="text-xs font-medium text-foreground">
        Description
      </label>
      <Textarea id="dispatch-voice-prompt" rows={3} value={prompt} maxLength={CUSTOM_VOICE_PROMPT_MAX} placeholder={CUSTOM_VOICE_EXAMPLE} onChange={(event) => setPrompt(event.target.value)} />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!canCreate || busy || name.trim() === "" || prompt.trim() === ""} onClick={() => void create()}>
          {busy ? "Creating…" : "Create voice"}
        </Button>
        {created ? <Note tone="ok">Created {created}. It is under Your voices.</Note> : null}
      </div>
      {error ? <Note tone="error">{error}</Note> : null}
    </Disclosure>
  );
}

/** The voice part of the Agent section. `hasKey` comes from setup status. */
export function VoiceSettings({ prefs, save, adopt, hasKey }: { prefs: Preferences; save: Save; adopt: (prefs: Preferences) => void; hasKey: boolean }) {
  const rpc = useRpc<RpcContract>();
  // A listed voice in the default style plays the sample that ships with Dispatch.
  // Anything else is made with the owner's key.
  const bundled = (voice: string) => !prefs.customVoices.some((item) => item.id === voice) && hasBundledSample(voice, prefs.voiceModel);
  const premade = (voice: string, style: SampleStyle) => bundled(voice) && (style === "default" || isDefaultStyle(prefs.voiceStyle));
  const player = useSamplePlayer(premade);
  const [error, setError] = useState<string | null>(null);

  const remove = (id: string) => {
    if (player.current?.voice === id) player.stop();
    rpc
      .call("voiceRemove", { id })
      .then((next) => {
        adopt(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorText(cause)));
  };

  const canPlay = (voice: string) => hasKey || premade(voice, "default");
  const canPreview = hasKey || premade(prefs.voice, "saved");

  return (
    <>
      <VoicePicker prefs={prefs} save={save} player={player} hasKey={hasKey} canPlay={canPlay} remove={remove} />
      {error ? <Note tone="error">{error}</Note> : null}
      <DesignVoice canCreate={hasKey} onCreated={adopt} />
      <VoiceStyleGroup prefs={prefs} save={save} player={player} canPreview={canPreview} />
    </>
  );
}
