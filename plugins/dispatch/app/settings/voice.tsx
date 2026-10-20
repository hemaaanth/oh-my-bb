// Voice settings in the Agent section: the voice list with samples, the voice
// style, and custom voices. GPT-Live has no speed or tone fields, so the style
// is a set of sentences in the voice prompt, and the copy says so.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CUSTOM_VOICE_EXAMPLE,
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
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { errorText, useLatest } from "./data.js";
import { Group, Note, Row } from "./layout.js";

type Save = (patch: Partial<Preferences>) => Promise<boolean>;

export const SAMPLE_COST_NOTE = "Uses your OpenAI key. About 1¢ per new sample.";
export const SAMPLE_NO_KEY_NOTE = "Add an OpenAI API key in Setup to play samples and design voices.";
export const STYLE_NOTE = "These are instructions in the voice prompt. The voice model follows them, but they are not exact controls.";

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Language, accent, and presentation, as far as the OpenAI voice table gives them. */
export function voiceDetail(voice: VoiceOption): string {
  if (voice.group !== "GPT-Live") return "Realtime voice";
  if (!voice.language) return "GPT-Live default";
  return [voice.region ? `${voice.language}, ${voice.region}` : voice.language, voice.presentation].filter(Boolean).join(" · ");
}

type Player = {
  /** The voice whose sample is loading or playing. */
  current: { voice: string; playing: boolean } | null;
  error: string | null;
  play: (voice: string) => void;
  stop: () => void;
};

/** Plays one sample at a time. A new play stops the one before it. */
function useSamplePlayer(): Player {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const turn = useRef(0);
  const [current, setCurrent] = useState<Player["current"]>(null);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    turn.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    setCurrent(null);
  }, []);

  const play = useCallback(
    (voice: string) => {
      stop();
      const mine = turn.current;
      setError(null);
      setCurrent({ voice, playing: false });
      rpcRef.current
        .call("voiceSample", { voice })
        .then(async ({ wav }) => {
          if (mine !== turn.current) return;
          const audio = new Audio(`data:audio/wav;base64,${wav}`);
          audioRef.current = audio;
          audio.onended = () => {
            if (audioRef.current === audio) stop();
          };
          setCurrent({ voice, playing: true });
          await audio.play();
        })
        .catch((cause: unknown) => {
          if (mine !== turn.current) return;
          stop();
          setError(errorText(cause));
        });
    },
    [rpcRef, stop],
  );

  useEffect(() => stop, [stop]);
  return { current, error, play, stop };
}

function PlayButton({ voice, label, player, canPlay }: { voice: string; label: string; player: Player; canPlay: boolean }) {
  const mine = player.current?.voice === voice ? player.current : null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={mine ? `Stop ${label}` : `Play ${label}`}
      disabled={!canPlay}
      onClick={() => (mine ? player.stop() : player.play(voice))}
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
  canPlay: boolean;
  onRemove?: (voice: string) => void;
}) {
  if (voices.length === 0) return null;
  return (
    <section aria-label={title} className="py-1">
      <h5 className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{title}</h5>
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
            <PlayButton voice={voice.name} label={voice.label} player={player} canPlay={canPlay} />
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

function VoicePicker({ prefs, save, player, canPlay, remove }: { prefs: Preferences; save: Save; player: Player; canPlay: boolean; remove: (id: string) => void }) {
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
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Voice</span>
        <span className="truncate text-xs text-muted-foreground">{chosen ? `${chosen.label} · ${chosen.detail}` : prefs.voice}</span>
      </div>
      <Note>{canPlay ? SAMPLE_COST_NOTE : SAMPLE_NO_KEY_NOTE}</Note>
      <div role="group" aria-label="Voice" className="max-h-80 overflow-y-auto rounded-md border border-input p-1">
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
      <label htmlFor="dispatch-style-notes" className="text-sm font-medium text-foreground">
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

function VoiceStyleGroup({ prefs, save, player, canPlay }: { prefs: Preferences; save: Save; player: Player; canPlay: boolean }) {
  const style = prefs.voiceStyle;
  const change = (patch: Partial<VoiceStyle>) => void save({ voiceStyle: { ...style, ...patch } });
  return (
    <div className="py-3">
      <Group title="Voice style">
        <Note>{STYLE_NOTE}</Note>
        {STYLE_ROWS.map((row) => (
          <Row key={row.key} label={row.label} help={row.help} inline>
            <div role="group" aria-label={row.label} className="flex rounded-md border border-input p-0.5">
              {VOICE_STYLE_CHOICES[row.key].map((choice) => (
                <Button key={choice} variant="ghost" size="sm" className="h-7 px-2.5" aria-pressed={style[row.key] === choice} onClick={() => change({ [row.key]: choice })}>
                  {capitalise(choice)}
                </Button>
              ))}
            </div>
          </Row>
        ))}
        <StyleNotes saved={style.notes} save={(notes) => change({ notes })} />
        <div className="flex items-center gap-2 py-3">
          <Button variant="outline" size="sm" disabled={!canPlay} onClick={() => (player.current ? player.stop() : player.play(prefs.voice))}>
            {player.current ? "Stop preview" : "Preview with this style"}
          </Button>
          <span className="text-xs text-muted-foreground">Plays the chosen voice with these settings.</span>
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
    <details className="py-3">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">Design a voice</summary>
      <div className="mt-2 flex flex-col gap-2">
        <Note>OpenAI makes a new voice from your description. Creating it is free. Your key needs the api.voices.write permission. OpenAI keeps the voice; Remove only takes it off this list.</Note>
        <label htmlFor="dispatch-voice-name" className="text-xs font-medium text-foreground">
          Voice name
        </label>
        <Input id="dispatch-voice-name" value={name} maxLength={CUSTOM_VOICE_NAME_MAX} className="h-8 sm:w-56" onChange={(event) => setName(event.target.value)} />
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
      </div>
    </details>
  );
}

/** The voice part of the Agent section. `hasKey` comes from setup status. */
export function VoiceSettings({ prefs, save, adopt, hasKey }: { prefs: Preferences; save: Save; adopt: (prefs: Preferences) => void; hasKey: boolean }) {
  const rpc = useRpc<RpcContract>();
  const player = useSamplePlayer();
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

  return (
    <>
      <VoicePicker prefs={prefs} save={save} player={player} canPlay={hasKey} remove={remove} />
      {error ? <Note tone="error">{error}</Note> : null}
      <DesignVoice canCreate={hasKey} onCreated={adopt} />
      <VoiceStyleGroup prefs={prefs} save={save} player={player} canPlay={hasKey} />
    </>
  );
}
