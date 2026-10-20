// Draws Dispatch's toasts at the bottom of the window. The bindings overlay
// mounts it once per realm. Toasts are announced politely to screen readers.

import { createPortal } from "react-dom";
import { cn } from "@/app/lib/utils.js";
import { usePortalScopeProps } from "@/app/lib/portal-scope.js";
import { dismissToast, useToasts } from "./toasts.js";

export function Toaster() {
  const toasts = useToasts();
  const scope = usePortalScopeProps();
  if (typeof document === "undefined" || toasts.length === 0) return null;
  return createPortal(
    <div
      {...scope}
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[2147482000] flex flex-col items-center gap-2 px-4 pb-[env(safe-area-inset-bottom)]"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-dispatch-toast={toast.tone}
          className={cn(
            "pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg",
            toast.tone === "error" ? "border-destructive/50" : "border-border",
          )}
        >
          <span className="min-w-0 flex-1">{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-state-hover"
              onClick={() => {
                dismissToast(toast.id);
                toast.action?.run();
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 cursor-pointer rounded-md px-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
