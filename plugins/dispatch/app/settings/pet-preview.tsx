// A drawing of the pet for the Appearance section. It shows the owner's look
// in each mood. The footer pet is P2's own component; this one only previews.
import type { PetMood } from "../../shared/constants.js";
import type { PetLook } from "../../shared/contract.js";
import { cn } from "../lib/utils";

type Eyes = "closed" | "half" | "dots" | "wide" | "side" | "slits" | "rings" | "happy" | "cross";
type Mouth = "none" | "line" | "open" | "smile" | "flat";

/** How each mood looks. The table is the whole animation vocabulary of the preview. */
const FACES: Record<PetMood, { eyes: Eyes; mouth: Mouth }> = {
  asleep: { eyes: "closed", mouth: "none" },
  waking: { eyes: "half", mouth: "none" },
  awake: { eyes: "dots", mouth: "smile" },
  listening: { eyes: "wide", mouth: "none" },
  talking: { eyes: "dots", mouth: "open" },
  looking: { eyes: "side", mouth: "flat" },
  reading: { eyes: "slits", mouth: "flat" },
  searching: { eyes: "rings", mouth: "flat" },
  typing: { eyes: "dots", mouth: "line" },
  sending: { eyes: "dots", mouth: "smile" },
  working: { eyes: "slits", mouth: "line" },
  done: { eyes: "happy", mouth: "smile" },
  failed: { eyes: "cross", mouth: "flat" },
};

function EyeShapes({ kind, x }: { kind: Eyes; x: number }) {
  switch (kind) {
    case "closed":
      return <path d={`M${x - 4} 25 h8`} strokeLinecap="round" />;
    case "half":
      return <path d={`M${x - 4} 25 a4 4 0 0 1 8 0`} strokeLinecap="round" />;
    case "wide":
      return <circle cx={x} cy={24} r={4.5} fill="currentColor" />;
    case "side":
      return <circle cx={x + 2} cy={24} r={3} fill="currentColor" />;
    case "slits":
      return <path d={`M${x - 4} 24 h8`} strokeLinecap="round" />;
    case "rings":
      return <circle cx={x} cy={24} r={4} />;
    case "happy":
      return <path d={`M${x - 4} 26 a4 4 0 0 1 8 0`} strokeLinecap="round" />;
    case "cross":
      return <path d={`M${x - 3} 21 l6 6 M${x + 3} 21 l-6 6`} strokeLinecap="round" />;
    default:
      return <circle cx={x} cy={24} r={3} fill="currentColor" />;
  }
}

function MouthShape({ kind }: { kind: Mouth }) {
  switch (kind) {
    case "none":
      return null;
    case "line":
      return <path d="M25 36 h10" strokeLinecap="round" />;
    case "open":
      return <ellipse cx={30} cy={36} rx={4} ry={3} fill="currentColor" />;
    case "smile":
      return <path d="M24 34 q6 6 12 0" strokeLinecap="round" />;
    default:
      return <path d="M26 36 h8" strokeLinecap="round" />;
  }
}

export function PetPreview({ mood, look, scale = 3 }: { mood: PetMood; look: PetLook; scale?: number }) {
  const face = FACES[mood];
  const radius = (look.roundness / 100) * 20;
  const themed = look.color === "theme";
  return (
    <svg
      role="img"
      aria-label={`Pet preview, ${mood}`}
      data-mood={mood}
      data-style={look.style}
      viewBox="0 0 60 56"
      width={60 * scale}
      height={56 * scale}
      className={cn(themed && "text-foreground")}
      style={themed ? undefined : { color: look.color }}
    >
      <g fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M30 12 V5" strokeLinecap="round" />
        <circle cx={30} cy={4} r={2.5} fill="currentColor" className={look.antennaFlash ? "animate-pulse" : undefined} />
        <rect x={6} y={12} width={48} height={36} rx={radius} fill={look.style === "solid" ? "currentColor" : "none"} />
      </g>
      {/* On a solid head the face is drawn in the page background so it stays readable. */}
      <g fill="none" stroke={look.style === "solid" ? "var(--background, #fff)" : "currentColor"} strokeWidth={2} color={look.style === "solid" ? "var(--background, #fff)" : undefined}>
        <EyeShapes kind={face.eyes} x={22} />
        <EyeShapes kind={face.eyes} x={38} />
        <MouthShape kind={face.mouth} />
      </g>
    </svg>
  );
}
