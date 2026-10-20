// Draws the pointer ghost (see model.ts) once per app window. The layer takes
// no pointer input and is hidden from screen readers: the agent already speaks,
// and a second spoken channel would talk over it.
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/app/lib/utils.js";
import { usePortalScopeProps } from "@/app/lib/portal-scope.js";
import { useAgentName } from "@/voice/preferences.js";
import { pointerGhost } from "./model.js";

function PointerGlyph() {
  return (
    <svg viewBox="0 0 20 22" className="block h-[22px] w-5" aria-hidden>
      <path
        d="M2 1.5 L2 17.2 L6.3 13.3 L9.1 19.6 L12 18.3 L9.3 12.1 L15.2 12.1 Z"
        className="fill-primary stroke-background"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PointerGhostOverlay() {
  const ghost = useSyncExternalStore(pointerGhost.subscribe, pointerGhost.get);
  const name = useAgentName();
  // Carry the plugin style scope into document.body, but leave out the
  // portaled-overlay marker. That marker routes desktop pointer input to the
  // layer, and this layer must never take input from the window under it.
  const { "data-bb-portaled-overlay": _overlay, ...scope } = usePortalScopeProps();

  // Any touch or click by the user hides the ghost and cancels a send it is
  // still walking towards.
  useEffect(() => {
    const touched = () => pointerGhost.userTouched();
    window.addEventListener("pointerdown", touched, { capture: true, passive: true });
    return () => window.removeEventListener("pointerdown", touched, { capture: true });
  }, []);

  if (typeof document === "undefined") return null;
  const fade = cn("transition-opacity duration-150", ghost.visible ? "opacity-100" : "opacity-0");
  return createPortal(
    <div {...scope} aria-hidden data-dispatch-ghost="" className="pointer-events-none fixed inset-0 z-[2147483000] overflow-hidden">
      {ghost.at ? (
        <div
          className={cn("absolute left-0 top-0", fade)}
          style={{
            transform: `translate3d(${ghost.at.x}px, ${ghost.at.y}px, 0)`,
            transition: `transform ${ghost.moveMs}ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 150ms`,
          }}
        >
          {ghost.presses > 0 ? (
            <span key={ghost.presses} className="dispatch-ghost-press absolute -left-3 -top-3 size-6 rounded-full border-2 border-primary" />
          ) : null}
          <div className="relative -left-0.5 -top-0.5 drop-shadow-md">
            <PointerGlyph />
          </div>
          <span className="absolute left-5 top-5 whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground shadow-md">
            {name}
          </span>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
