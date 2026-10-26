import { useContext, useLayoutEffect, useRef, useState } from "react";
import { useFormName, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis } from "../icons.generated.js";
import { focusRing, SentContext, useReadOnly } from "../kit.js";
import { menuContent, menuItem, PORTAL_SCOPE } from "../../ui.js";

/** Opening the menu does nothing. Only selecting its request uses the native chat action. */
export function FollowUpMenu({ label, message }: { label: string; message: () => string }) {
  const trigger = useTriggerAction();
  const form = useFormName() ?? "";
  const streaming = useIsStreaming();
  const readOnly = useReadOnly();
  const { sent } = useContext(SentContext);
  const button = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | ShadowRoot>();
  useLayoutEffect(() => {
    if (!button.current) return;
    const root = button.current.getRootNode();
    setPortal(root instanceof ShadowRoot ? root : document.body);
  }, [readOnly]);
  if (readOnly) return null;
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button ref={button} type="button" aria-label={label} disabled={streaming || sent[form] !== undefined} className={`inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover disabled:opacity-40 ${focusRing}`}><Ellipsis aria-hidden className="size-4" /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={portal}><DropdownMenu.Content {...PORTAL_SCOPE} align="end" sideOffset={4} collisionPadding={8} className={`z-[75] min-w-40 max-w-[calc(100vw-16px)] ${menuContent}`}><DropdownMenu.Item disabled={streaming || sent[form] !== undefined} onSelect={() => void trigger(message(), form)} className={menuItem}>{label}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
