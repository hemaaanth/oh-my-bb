import { useRef, useState } from "react";
import type { SidebarWorkspace } from "../shared";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export function DeleteSectionDialog({ workspace, onDismiss, onRemove }: {
  workspace: SidebarWorkspace;
  onDismiss: () => void;
  onRemove: (workspaceId: string) => Promise<void>;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true);
    setError(null);
    try { await onRemove(workspace.id); onDismiss(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete section."); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
    <DialogContent className="max-w-md" onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}>
      <DialogHeader><DialogTitle>Delete {workspace.name}?</DialogTitle><DialogDescription>Projects return to the default section. Threads and projects are not deleted.</DialogDescription></DialogHeader>
      {error ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : null}
      <div className="flex justify-end gap-2"><Button ref={cancel} autoFocus variant="outline" onClick={onDismiss}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>Delete</Button></div>
    </DialogContent>
  </Dialog>;
}
