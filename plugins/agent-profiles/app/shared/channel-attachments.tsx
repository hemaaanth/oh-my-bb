import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Attachment } from "../../server/channels/contract";
import { Button } from "@/components/ui/button";
import { inlineImage } from "./image-format";

const url = (attachment: Attachment, inline = false) =>
  `/api/v1/plugins/agent-profiles/http/attachment?id=${encodeURIComponent(attachment.id)}${inline ? "&inline=1" : ""}`;

export function ChannelAttachments({
  attachments,
  onRemove,
  disabled,
  onImageLoad,
}: {
  attachments: Attachment[];
  onRemove?: (attachment: Attachment) => void;
  disabled?: boolean;
  onImageLoad?: () => void;
}) {
  const [expanded, setExpanded] = useState<Attachment | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <div key={attachment.id} className="group relative max-w-full overflow-hidden rounded-md border border-border bg-card">
            {inlineImage(attachment) && !failed.includes(attachment.id) ? (
              <button type="button" className="block max-w-full" aria-label={`Expand ${attachment.name}`} onClick={() => setExpanded(attachment)}>
                <img
                  loading="lazy"
                  className="max-h-72 max-w-full object-contain"
                  src={url(attachment, true)}
                  alt={attachment.alt || attachment.name}
                  onLoad={onImageLoad}
                  onError={() => setFailed((ids) => [...ids, attachment.id])}
                />
              </button>
            ) : (
              <a className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-state-hover" href={url(attachment)} download={attachment.name}>
                <Icon name="Paperclip" className="size-4 shrink-0" />
                <span className="truncate">{attachment.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {attachment.sizeBytes < 1024 ? `${attachment.sizeBytes} B` : `${Math.ceil(attachment.sizeBytes / 1024)} KB`}
                </span>
              </a>
            )}
            {onRemove ? (
              <button
                type="button"
                className="absolute right-1 top-1 rounded bg-popover p-1 text-popover-foreground shadow"
                aria-label={`Remove ${attachment.name}`}
                disabled={disabled}
                onClick={() => onRemove(attachment)}
              >
                <Icon name="X" className="size-3.5" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <Dialog.Root open={!!expanded} onOpenChange={(open) => { if (!open) setExpanded(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60" style={{ zIndex: 70 }} />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
            style={{ zIndex: 71, maxHeight: "90vh", width: "min(92vw, 72rem)" }}
            aria-describedby={undefined}
          >
            <header className="mb-3 flex items-center gap-3">
              <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-medium">{expanded?.name}</Dialog.Title>
              <a className="text-xs text-muted-foreground hover:text-foreground" href={expanded ? url(expanded) : undefined} download={expanded?.name}>Download</a>
              <Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="Close image"><Icon name="X" /></Button></Dialog.Close>
            </header>
            {expanded ? <img className="mx-auto max-h-[78vh] max-w-full object-contain" src={url(expanded, true)} alt={expanded.alt || expanded.name} /> : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
