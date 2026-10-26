// Appearance (SPEC §12.4): the real pet with a mood picker, the look controls,
// and the pointer ghost switch. Every look change writes the whole `pet` object.
import { useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { HexColorPicker } from "react-colorful";
import { PET_MOODS, type PetMood } from "../../shared/constants.js";
import type { PetLook } from "../../shared/contract.js";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Icon } from "../components/ui/icon";
import { Switch } from "../components/ui/switch";
import { usePreferences } from "./data.js";
import { readPointerGhost, useDeviceValue, writePointerGhost } from "./device.js";
import { Group, Loading, Note, Row, Segmented, SettingSelect } from "./layout.js";
import { Pet } from "../pet/pet.js";
import { FACE_LABEL, type PetFace } from "../pet/mood.js";
import { LOCAL_KEYS } from "../../shared/constants.js";
import { usePortalScopeProps } from "../lib/portal-scope";

const PRESET_COLORS = [
  ["Red", "#e5484d"], ["Orange", "#f76b15"], ["Yellow", "#ffc53d"],
  ["Green", "#30a46c"], ["Blue", "#0090ff"], ["Purple", "#8e4ec6"], ["Pink", "#e93d82"],
] as const;
const HEX = /^#[0-9a-f]{6}$/i;
const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
/** The pet face for each mood chip. FACE_LABEL names each face; this reads it backwards. */
const FACE_FOR = Object.fromEntries(Object.entries(FACE_LABEL).map(([face, mood]) => [mood, face])) as Record<PetMood, PetFace>;

/** Turns a stream of look changes into writes, one at a time. The newest change waits its turn. */
function useLookWriter(write: (look: PetLook) => Promise<boolean>, onIdle: () => void) {
  const busy = useRef(false);
  const waiting = useRef<PetLook | null>(null);
  const writeRef = useRef(write);
  writeRef.current = write;
  const idleRef = useRef(onIdle);
  idleRef.current = onIdle;
  const send = async (look: PetLook): Promise<void> => {
    if (busy.current) {
      waiting.current = look;
      return;
    }
    busy.current = true;
    try {
      await writeRef.current(look);
    } finally {
      busy.current = false;
    }
    const next = waiting.current;
    waiting.current = null;
    if (next) await send(next);
    else idleRef.current();
  };
  return send;
}

function CustomColour({ color, onPreview, onChange }: { color: string; onPreview(color: string): void; onChange(color: string): void }) {
  const saved = color === "theme" ? "" : color;
  const [previous, setPrevious] = useState(color);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const errorId = useId();
  const scope = usePortalScopeProps();
  if (previous !== color) {
    setPrevious(color);
    setDraft(saved);
    setError(false);
  }
  const commit = () => {
    if (draft === saved) return;
    const hex = `#${draft.trim().replace(/^#/, "")}`.toLowerCase();
    if (!HEX.test(hex)) { setError(true); return; }
    setDraft(hex);
    if (hex !== color) onChange(hex);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="outline" className="h-8 w-full justify-between px-2.5 text-xs">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="size-4 rounded-sm border border-border" style={{ backgroundColor: color === "theme" ? "currentColor" : color }} />
            Custom colour
          </span>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...scope}
          aria-label="Custom colour"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          onInteractOutside={commit}
          onEscapeKeyDown={() => { setDraft(saved); setError(false); }}
          className="dispatch-colour-picker z-50 max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[calc(100vw-24px)] space-y-3 overflow-y-auto rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <HexColorPicker color={HEX.test(color) ? color : "#808080"} onChange={onPreview} onChangeEnd={onChange} aria-label="Custom colour picker" />
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Hex (optional)</span>
            <Input
              aria-label="Hex colour"
              aria-invalid={error}
              aria-describedby={error ? errorId : undefined}
              placeholder="#RRGGBB"
              spellCheck={false}
              maxLength={7}
              className="h-8 font-mono text-xs"
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setError(false); }}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
              }}
            />
          </label>
          {error ? <p id={errorId} className="text-xs text-destructive">Use a six-digit hex colour.</p> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function AppearanceSection() {
  const { prefs, error, save } = usePreferences();
  const [mood, setMood] = useState<PetMood>("awake");
  const [local, setLocal] = useState<PetLook | null>(null);
  const [ghost, setGhost] = useDeviceValue(LOCAL_KEYS.pointerGhost, readPointerGhost, writePointerGhost);
  const send = useLookWriter(
    (pet) => save({ pet }),
    () => setLocal(null),
  );

  if (!prefs) return <Loading error={error} />;
  // The server copy is the truth. A local copy only covers the moment between a drag and its echo.
  const look = local ?? prefs.pet;
  const change = (patch: Partial<PetLook>) => {
    const next = { ...look, ...patch };
    setLocal(next);
    void send(next);
  };

  return (
    <Group title="Appearance">
      <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 py-4">
        <span role="img" aria-label={`Pet preview, ${mood}`} data-mood={mood}>
          <Pet face={FACE_FOR[mood]} look={look} className="dispatch-pet-preview" />
        </span>
        <div className="flex w-72 min-w-0 max-w-full flex-col gap-2">
          <label htmlFor="dispatch-preview-mood" className="text-xs text-muted-foreground">Preview mood</label>
          <SettingSelect id="dispatch-preview-mood" label="Preview mood" value={mood} options={PET_MOODS.map((name) => ({ value: name, label: capitalise(name) }))} onValueChange={(value) => setMood(value as PetMood)} />
        </div>
      </div>

      <Row label="Style">
        <Segmented label="Style" value={look.style} options={(["outline", "solid"] as const).map((style) => ({ value: style, label: capitalise(style) }))} onChange={(style) => change({ style })} />
      </Row>

      <Row label="Colour">
        <div role="group" aria-label="Colour" className="w-full min-w-0 space-y-2 @md:w-72">
          <div className="grid grid-cols-3 gap-1 rounded-md border border-input p-1 @min-[17rem]:grid-cols-4">
            <Button variant={look.color === "theme" ? "secondary" : "ghost"} size="sm" className="h-7 justify-start gap-1 px-1 text-xs" aria-pressed={look.color === "theme"} onClick={() => change({ color: "theme" })}>
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-foreground" />
              Theme
            </Button>
            {PRESET_COLORS.map(([name, color]) => (
              <Button
                key={color}
                variant={look.color.toLowerCase() === color ? "secondary" : "ghost"}
                size="sm"
                aria-label={`Colour ${color}`}
                aria-pressed={look.color.toLowerCase() === color}
                onClick={() => change({ color })}
                className="h-7 justify-start gap-1 px-1 text-xs"
              >
                <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {name}
              </Button>
            ))}
          </div>
          <CustomColour color={look.color} onPreview={(color) => setLocal({ ...look, color })} onChange={(color) => change({ color })} />
        </div>
      </Row>

      <Row label="Head shape" htmlFor="dispatch-roundness" help="From square to round.">
        <input
          id="dispatch-roundness"
          type="range"
          min={0}
          max={100}
          step={1}
          value={look.roundness}
          className="w-full accent-current @md:w-48"
          onChange={(event) => change({ roundness: Number(event.target.value) })}
        />
      </Row>

      <Row label="Follow the pointer" placement="trailing" help="The pet follows your pointer.">
        <Switch aria-label="Follow the pointer" checked={look.followPointer} onCheckedChange={(followPointer) => change({ followPointer })} />
      </Row>
      <Row label="Flash the antenna" placement="trailing" help="Blink while the agent works.">
        <Switch aria-label="Flash the antenna" checked={look.antennaFlash} onCheckedChange={(antennaFlash) => change({ antennaFlash })} />
      </Row>

      <Row label="Pointer ghost" placement="trailing" help="Show the agent's focus on this device.">
        <Switch aria-label="Pointer ghost" checked={ghost} onCheckedChange={setGhost} />
      </Row>
      {error ? <Note tone="error">{error}</Note> : null}
    </Group>
  );
}
