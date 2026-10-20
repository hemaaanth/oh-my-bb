// The footer pet (SPEC §7): a small robot face from agent-robot-avatar in BB's
// sidebar footer. It sleeps with no call, wakes when one starts, and acts out
// what the agent does: listening, talking, reading, searching, looking at a
// thread, typing, sending. mood.ts picks the face; this file turns a face into
// avatar calls and draws the footer icon. The footer button around the icon
// toggles the call. A long press or right-click opens the pet's menu.
import { useEffect, useRef, useState, type HTMLAttributes, type RefObject } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import "agent-robot-avatar";
import type { AgentRobotAvatar } from "agent-robot-avatar";
import { cn } from "@/app/lib/utils.js";
import { usePortalScopeProps } from "@/app/lib/portal-scope.js";
import { useCall } from "@/voice/call-store.js";
import { callMyPhone, toggleCall } from "@/voice/engine.js";
import { useAgentName, usePrefs, useSetup } from "@/voice/preferences.js";
import { openDispatchSettings } from "@/voice/settings-opener.js";
import { PET_MARKER } from "@/app/pointer-ghost/model.js";
import { PET_THEME_COLOR, type PetLook, type PetStyle } from "./look.js";
import { FACE_LABEL, nextFace, OUTCOME_MS, petFace, type PetFace, type ShownFace } from "./mood.js";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "agent-robot-avatar": HTMLAttributes<HTMLElement> & {
        ref?: RefObject<AgentRobotAvatar | null>;
        color?: string;
        "wake-on"?: "activity" | "interaction" | "manual";
        "press-squeeze"?: string;
        "antenna-drag"?: string;
      };
    }
  }
}

/** The app icon name the footer item uses. The icon component is the pet. */
export const PET_ICON = "dispatch-pet";

/** The face the call asks for now. Re-renders when an outcome face ends. */
export function useWantedFace(): PetFace {
  const call = useCall();
  const [, tick] = useState(0);
  const outcome = call.outcome;
  useEffect(() => {
    if (!outcome) return;
    const left = outcome.at + OUTCOME_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => tick((n) => n + 1), left + 20);
    return () => clearTimeout(timer);
  }, [outcome]);
  return petFace({ state: call.state, activity: call.activity, work: call.work, outcome, now: Date.now() });
}

/**
 * The face on screen. Each face stays for its hold, so a quick tool still
 * shows; listening and talking linger through short pauses (mood.ts).
 */
export function usePetFace(): PetFace {
  const wanted = useWantedFace();
  const shown = useRef<ShownFace>({ face: wanted, since: 0, seenAt: 0 });
  const lastWanted = useRef<PetFace>(wanted);
  const [, tick] = useState(0);
  const now = Date.now();
  let current = shown.current;
  // The signals asked for the shown face until this render.
  if (lastWanted.current === current.face && wanted !== current.face) current = { ...current, seenAt: now };
  lastWanted.current = wanted;
  const next = nextFace(current, wanted, now);
  shown.current = next.shown;
  const recheckIn = next.recheckIn;
  useEffect(() => {
    if (recheckIn === null) return;
    const timer = setTimeout(() => tick((n) => n + 1), recheckIn + 10);
    return () => clearTimeout(timer);
  });
  return next.shown.face;
}

/** Listening and typing both show the avatar's text cursor: words going in. */
const INPUT_FACES: ReadonlySet<PetFace> = new Set(["listen", "type"]);
/**
 * Working alternates the avatar's two waiting loops, one cycle each, so it
 * reads as busy and not stuck. Each cycle ends with the eyes back home.
 */
const WORK_LOOPS = [
  { variant: "default", ms: 3200 },
  { variant: "wrap", ms: 2400 },
] as const;
/** After this long in a quiet live call, the pet looks around. */
const BORED_AFTER_MS = 15_000;

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function loopWork(avatar: AgentRobotAvatar, first: number, signal: AbortSignal) {
  for (let turn = first; !signal.aborted; turn++) {
    const { variant, ms } = WORK_LOOPS[turn % WORK_LOOPS.length]!;
    await avatar.startWaiting({ variant });
    await pause(ms, signal);
  }
}

async function act(avatar: AgentRobotAvatar, face: PetFace, previous: PetFace | null, signal: AbortSignal) {
  if (face === "sleep") {
    void avatar.input(false);
    avatar.reset();
    await avatar.sleep();
    return;
  }
  if (previous === "sleep") {
    await avatar.wake();
    if (signal.aborted) return;
  }
  if (previous && INPUT_FACES.has(previous) && !INPUT_FACES.has(face)) void avatar.input(false);
  switch (face) {
    case "listen":
    case "type":
      void avatar.input(true);
      break;
    // The eyes do the talking (FACE_CSS).
    case "talk":
      avatar.reset();
      break;
    case "wake":
      break;
    case "look":
      void avatar.play("surprise");
      break;
    case "read":
      void avatar.play("inspect");
      break;
    case "research":
      await loopWork(avatar, 1, signal);
      break;
    case "work":
      await loopWork(avatar, 0, signal);
      break;
    case "send":
      void avatar.play("send");
      break;
    case "happy":
      void avatar.play("success");
      break;
    case "oops":
      void avatar.play("failure");
      break;
    case "awake":
      avatar.reset();
      await pause(BORED_AFTER_MS, signal);
      if (!signal.aborted) void avatar.play("bored");
  }
}

/** Drive an avatar from a face. A new face or an unmount stops the old one's loops. */
function useAvatarFace(ref: RefObject<AgentRobotAvatar | null>, face: PetFace) {
  const shown = useRef<PetFace | null>(null);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => {
    const avatar = ref.current;
    if (!avatar || shown.current === face) return;
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    const previous = shown.current;
    shown.current = face;
    void act(avatar, face, previous ?? "awake", controller.signal).catch(() => undefined);
  }, [ref, face]);
}

/**
 * Draw the pet like the sidebar's other icons, in the icon color or the
 * user's color. Outline: the head takes the sidebar background, a ring is
 * drawn on top, and the eyes and antenna are solid. Solid: the head and
 * antenna are filled and the eyes are cut out in the background. The eyelids
 * take the head's fill so blinks and sleep still read. The stroke is in avatar
 * units: 240 across, drawn at 20 px, so 14 is about 1.1 px.
 *
 * The ring is a separate element above the eyes. A stroke on #head itself
 * would be covered by the eyelids when the eyes look to the side.
 */
const LOOK_CSS: Record<PetStyle, string> = {
  outline: `
  #head, #leftTop, #leftBottom, #rightTop, #rightBottom { fill: var(--sidebar, Canvas); }
  #dispatchRing { fill: none; stroke: currentColor; stroke-width: 14px; pointer-events: none; }
  #leftBase, #rightBase, #leftInputBase, #rightInputBase, #antennaDot { fill: currentColor; }
`,
  solid: `
  #head, #leftTop, #leftBottom, #rightTop, #rightBottom, #antennaDot { fill: currentColor; }
  #dispatchRing { display: none; }
  #leftBase, #rightBase, #leftInputBase, #rightInputBase { fill: var(--sidebar, Canvas); }
`,
};

/**
 * Face details inside the avatar's shadow root, keyed on the host's data-mood:
 * - The text cursor (listening, typing) dims on its blink instead of
 *   vanishing, so the face is never empty. In the input pose the avatar
 *   writes the cursor opacity as "1.000" or "0.000".
 * - Talking squeezes the eyes in a speech rhythm.
 * - Working and searching pulse the antenna light.
 */
const FACE_CSS = `
  #leftBase, #rightBase { transform-box: fill-box; transform-origin: center; }
  #leftInputBase, #rightInputBase { transition: opacity .2s ease-in-out; }
  #leftInputBase[opacity="0.000"], #rightInputBase[opacity="0.000"] { opacity: .35; }
  @keyframes dispatch-say {
    0%, 70%, 100% { transform: scaleY(1); }
    18% { transform: scaleY(.45); }
    34% { transform: scaleY(.9); }
    52% { transform: scaleY(.6); }
    84% { transform: scaleY(.5); }
  }
  :host([data-mood="talk"]) #leftBase, :host([data-mood="talk"]) #rightBase { animation: dispatch-say .9s ease-in-out infinite; }
  :host([data-mood="talk"]) #rightBase { animation-delay: -.12s; }
  @keyframes dispatch-glow { 50% { opacity: .2; } }
  :host([data-mood="work"]) #antennaDot, :host([data-mood="research"]) #antennaDot { animation: dispatch-glow .8s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    #leftBase, #rightBase, #antennaDot { animation: none !important; }
  }
`;

/** Add the outline ring: a copy of the head shape, last in the head's motion group. */
function ensureRing(root: ShadowRoot) {
  const motion = root.getElementById("headMotion");
  const head = root.getElementById("head");
  if (!motion || !head || root.getElementById("dispatchRing")) return;
  const ring = head.cloneNode(false) as SVGElement;
  ring.id = "dispatchRing";
  ring.removeAttribute("fill");
  ring.setAttribute("aria-hidden", "true");
  motion.append(ring);
}

/** Apply a look: one style sheet in the shadow root, then the avatar's own settings. */
function useLook(ref: RefObject<AgentRobotAvatar | null>, look: PetLook) {
  useEffect(() => {
    const root = ref.current?.shadowRoot;
    if (!root) return;
    ensureRing(root);
    let style = root.querySelector<HTMLStyleElement>("style[data-dispatch-look]");
    if (!style) {
      style = document.createElement("style");
      style.dataset.dispatchLook = "";
      root.append(style);
    }
    style.dataset.style = look.style;
    style.textContent = LOOK_CSS[look.style] + FACE_CSS;
  }, [ref, look.style]);
  useEffect(() => {
    const avatar = ref.current;
    if (!avatar) return;
    avatar.setHeadRoundness?.(look.roundness);
    avatar.setPointerFollow?.(look.followPointer);
    avatar.setAntennaFlash?.(look.antennaFlash);
  }, [ref, look.roundness, look.followPointer, look.antennaFlash]);
}

/** A pet showing one face. `look` defaults to the saved one. */
export function Pet({ face, look, className }: { face: PetFace; look?: PetLook; className?: string }) {
  const saved = usePrefs().pet;
  const shown = look ?? saved;
  const ref = useRef<AgentRobotAvatar | null>(null);
  useLook(ref, shown);
  useAvatarFace(ref, face);
  // Only the call moves the pet. Clicks belong to the footer button around it.
  return (
    <span
      data-mood={face}
      className={cn("dispatch-pet", className)}
      style={shown.color === PET_THEME_COLOR ? undefined : { color: shown.color }}
    >
      <agent-robot-avatar
        ref={ref}
        data-mood={face}
        color="currentColor"
        wake-on="manual"
        press-squeeze="false"
        antenna-drag="false"
        aria-hidden
      />
    </span>
  );
}

/**
 * When the pet's menu last opened. The release that ends a long press can
 * also click the footer button below. The footer's onActivate asks here and
 * skips its toggle for that click.
 */
let menuOpenedAt = 0;
export const petMenuJustOpened = () => Date.now() - menuOpenedAt < 1000;

const MENU_ITEM =
  "flex cursor-default select-none flex-col items-start rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/**
 * The footer button's icon: a small live pet in the host's icon box. The host
 * draws the button, so the long press is caught here. The ::before pad widens
 * the press target from the icon to most of the button.
 */
export function PetIcon({ className }: { className?: string }) {
  const face = usePetFace();
  const { state } = useCall();
  const name = useAgentName();
  const setup = useSetup();
  const scope = usePortalScopeProps();
  // Unknown until the first read: leave the item on.
  const phoneBlocked = setup !== null && !setup.phone.ready;
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) menuOpenedAt = Date.now();
      }}
    >
      <ContextMenu.Trigger asChild>
        <span
          {...{ [PET_MARKER]: "" }}
          title={`${name} · ${FACE_LABEL[face]}`}
          className={cn(
            "relative inline-flex shrink-0 select-none items-center justify-center [-webkit-touch-callout:none] before:absolute before:-inset-2",
            className,
          )}
        >
          <Pet face={face} className="dispatch-pet-footer" />
        </span>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...scope}
          className="z-50 min-w-[11rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => void toggleCall()}>
            {state === "idle" ? `Wake ${name} here` : `Put ${name} to sleep`}
          </ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} disabled={phoneBlocked} onSelect={() => void callMyPhone()}>
            <span>Call my phone</span>
            {phoneBlocked ? (
              <span className="text-xs text-muted-foreground">Needs: {setup.phone.missing.join(", ") || "phone setup"}</span>
            ) : null}
          </ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} onSelect={openDispatchSettings}>
            Dispatch settings
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
