import * as Dialog from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";
import { usePortalScopeProps } from "../../lib/portal-scope.js";
import { useIsCompactViewport } from "./hooks/use-compact-viewport.js";
import { ResponsiveDrawerShell } from "./responsive-overlay.js";

export function GatewayDialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return useIsCompactViewport()
    ? <h2 id="gateway-dialog-title" className={className}>{children}</h2>
    : <Dialog.Title className={className}>{children}</Dialog.Title>;
}

export function GatewayDialog({ open, onOpenChange, onAfterCloseAutoFocus, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAfterCloseAutoFocus?: () => void;
  children: ReactNode;
}) {
  const compact = useIsCompactViewport();
  const scope = usePortalScopeProps();
  const opener = useRef<HTMLElement | null>(null);
  if (compact) return (
    <ResponsiveDrawerShell open={open} onOpenChange={onOpenChange} onAfterCloseAutoFocus={onAfterCloseAutoFocus} labelledBy="gateway-dialog-title">
      <div className="gateway-editor flex min-h-0 flex-1 flex-col">{children}</div>
    </ResponsiveDrawerShell>
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay {...scope} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...scope}
          aria-describedby={undefined}
          onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
            onAfterCloseAutoFocus?.();
          }}
          className="gateway-editor fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg outline-none"
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
