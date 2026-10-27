import { useState, type ReactNode } from "react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { Icon } from "./ui/icon.js";
export function SettingsDialog({ title, description, buttonLabel, icon = false, children }: { title: string; description: string; buttonLabel: string; icon?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" size="sm" aria-label={buttonLabel} className={icon ? "size-8 shrink-0 p-0" : "shrink-0"}>{icon ? <Icon name="Settings" className="size-4" /> : buttonLabel}</Button></DialogTrigger>{open && <DialogContent className="w-[calc(100%-2rem)] max-w-[640px] max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader><div className="min-w-0 space-y-4">{children}</div></DialogContent>}</Dialog>;
}
