// The call strip in the composer (SPEC §6.1). It registers this composer as
// the call's bindings while it is mounted, and while a call is live or muted
// it shows a waveform, the elapsed time, who is speaking, and Mute and Stop.
// While idle it draws only an empty marker: the pet is the start control.
import { useEffect, useRef, useState } from "react";
import { useBbContext, useComposer } from "@get-bb/plugin-sdk/app";
import { cn } from "@/app/lib/utils.js";
import { COMPOSER_MARKER } from "@/app/pointer-ghost/model.js";
import { useRegisterBindings, type ComposerBindings, type ScreenContext } from "@/voice/bindings.js";
import { isCallActive, useCall, type CallSnapshot } from "@/voice/call-store.js";
import { stopCall, toggleMute } from "@/voice/engine.js";
import { useAgentName } from "@/voice/preferences.js";
import { MiniPet } from "./pet/pet.js";

/** Marks a submit as Dispatch's, for dispatch hooks that care. */
const SUBMIT_DATA = { source: "dispatch" } as const;

/** m:ss, or h:mm:ss after an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** The activity dot's state. A suspended microphone wins over who is speaking. */
export function dotState(call: Pick<CallSnapshot, "activity" | "micSuspended">): "you" | "agent" | "idle" | "paused" {
  return call.micSuspended ? "paused" : call.activity;
}

const DOT_CLASS = {
  you: "bg-success",
  agent: "bg-primary",
  idle: "bg-muted-foreground/50",
  paused: "bg-warning",
} as const;

const DOT_LABEL = {
  you: "You are speaking",
  agent: "speaking",
  idle: "Nobody is speaking",
  paused: "Microphone paused",
} as const;

function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? formatElapsed(0) : formatElapsed(now - startedAt);
}

/** Five bars. They move only while the agent speaks (app.css). */
function Waveform({ speaking }: { speaking: boolean }) {
  return (
    <span aria-hidden className="dispatch-wave" data-speaking={speaking ? "" : undefined}>
      {[0, 1, 2, 3, 4].map((bar) => (
        <span key={bar} />
      ))}
    </span>
  );
}

function MicGlyph({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
      {off ? <path d="M2 2l12 12" /> : null}
    </svg>
  );
}

function StopGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="currentColor">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}

const STRIP_BUTTON =
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** The strip itself, for a call that is live or muted. */
export function CallStrip({ call, name }: { call: CallSnapshot; name: string }) {
  const elapsed = useElapsed(call.startedAt);
  const muted = call.state === "muted";
  const dot = dotState(call);
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground" role="group" aria-label={`${name} call`}>
      <MiniPet className="size-5" />
      <Waveform speaking={call.activity === "agent"} />
      <span className="tabular-nums" aria-label="Elapsed time">
        {elapsed}
      </span>
      <span
        role="img"
        aria-label={dot === "agent" ? `${name} is speaking` : DOT_LABEL[dot]}
        data-activity={dot}
        className={cn("size-1.5 rounded-full", DOT_CLASS[dot], dot === "paused" && "animate-pulse")}
      />
      <button
        type="button"
        className={STRIP_BUTTON}
        aria-pressed={muted}
        aria-label={muted ? `Unmute ${name}'s microphone` : `Mute ${name}'s microphone`}
        title={muted ? "Unmute" : "Mute"}
        onClick={() => void toggleMute()}
      >
        <MicGlyph off={muted} />
      </button>
      <button
        type="button"
        className={cn(STRIP_BUTTON, "hover:text-destructive")}
        aria-label={`Stop ${name}`}
        title="Stop"
        onClick={() => void stopCall()}
      >
        <StopGlyph />
      </button>
    </div>
  );
}

/** Lets the call read and write this composer's draft and send it. */
function useComposerBindings(): { context: ScreenContext; composer: ComposerBindings } {
  const composer = useComposer();
  const { projectId: routeProject } = useBbContext();
  const scope = composer.scope;
  const context: ScreenContext = {
    threadId: scope.kind === "new-thread" ? null : scope.threadId,
    projectId: scope.kind === "new-thread" ? scope.projectId ?? routeProject : routeProject,
    onNewThreadScreen: scope.kind === "new-thread",
  };
  // The handle is stable and always acts on the current draft.
  const bindings = useRef<ComposerBindings | null>(null);
  bindings.current ??= {
    draft: () => composer.draft,
    replace: (next) => composer.replace({ text: next.text, mentions: next.mentions }),
    submit: () => composer.submit({ experimental_data: SUBMIT_DATA }),
    focus: () => composer.focus(),
  };
  return { context, composer: bindings.current };
}

export function ComposerCallControls() {
  const { context, composer } = useComposerBindings();
  useRegisterBindings("composer", context, composer);
  const call = useCall();
  const name = useAgentName();
  return (
    <span {...{ [COMPOSER_MARKER]: "" }} className="inline-flex items-center">
      {isCallActive(call) ? <CallStrip call={call} name={name} /> : null}
    </span>
  );
}
