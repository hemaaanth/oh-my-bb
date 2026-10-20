// Appearance (SPEC §12.4): the pet preview with a mood picker, the look controls,
// and the pointer ghost switch. Every look change writes the whole `pet` object.
import { useRef, useState } from "react";
import { PET_MOODS, type PetMood } from "../../shared/constants.js";
import type { PetLook } from "../../shared/contract.js";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import { usePreferences } from "./data.js";
import { readPointerGhost, useDeviceValue, writePointerGhost } from "./device.js";
import { Group, Loading, Note, Row } from "./layout.js";
import { PetPreview } from "./pet-preview.js";
import { LOCAL_KEYS } from "../../shared/constants.js";

const PRESET_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#0090ff", "#8e4ec6", "#e93d82"];
const HEX = /^#[0-9a-f]{6}$/i;
const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

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
    <Group>
      <div className="flex flex-col items-center gap-3 py-3">
        <PetPreview mood={mood} look={look} />
        <div role="group" aria-label="Preview mood" className="flex flex-wrap justify-center gap-1.5">
          {PET_MOODS.map((name) => (
            <Button key={name} variant={name === mood ? "secondary" : "ghost"} size="sm" aria-pressed={name === mood} onClick={() => setMood(name)}>
              {capitalise(name)}
            </Button>
          ))}
        </div>
      </div>

      <Row label="Style">
        <div role="group" aria-label="Style" className="flex gap-1.5">
          {(["outline", "solid"] as const).map((style) => (
            <Button key={style} variant={look.style === style ? "secondary" : "outline"} size="sm" aria-pressed={look.style === style} onClick={() => change({ style })}>
              {capitalise(style)}
            </Button>
          ))}
        </div>
      </Row>

      <Row label="Colour">
        <div role="group" aria-label="Colour" className="flex flex-wrap items-center gap-1.5">
          <Button variant={look.color === "theme" ? "secondary" : "outline"} size="sm" aria-pressed={look.color === "theme"} onClick={() => change({ color: "theme" })}>
            Theme
          </Button>
          {PRESET_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Colour ${color}`}
              aria-pressed={look.color.toLowerCase() === color}
              onClick={() => change({ color })}
              className={cn("size-6 rounded-full border border-input", look.color.toLowerCase() === color && "ring-2 ring-ring ring-offset-1 ring-offset-background")}
              style={{ backgroundColor: color }}
            />
          ))}
          <input
            type="color"
            aria-label="Custom colour"
            className="h-7 w-9 cursor-pointer rounded border border-input bg-transparent p-0.5"
            value={HEX.test(look.color) ? look.color : "#808080"}
            onChange={(event) => HEX.test(event.target.value) && change({ color: event.target.value.toLowerCase() })}
          />
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
          className="w-full accent-current sm:w-48"
          onChange={(event) => change({ roundness: Number(event.target.value) })}
        />
      </Row>

      <Row label="Follow the pointer" help="The pet turns its eyes toward your pointer.">
        <Switch aria-label="Follow the pointer" checked={look.followPointer} onCheckedChange={(followPointer) => change({ followPointer })} />
      </Row>
      <Row label="Flash the antenna" help="The antenna blinks while the pet is busy.">
        <Switch aria-label="Flash the antenna" checked={look.antennaFlash} onCheckedChange={(antennaFlash) => change({ antennaFlash })} />
      </Row>

      <Row label="Pointer ghost" help="A ghost pointer shows where the agent is looking on screen. It only shows. It never clicks. This setting is for this device only.">
        <Switch aria-label="Pointer ghost" checked={ghost} onCheckedChange={setGhost} />
      </Row>
      {error ? <Note tone="error">{error}</Note> : null}
    </Group>
  );
}
