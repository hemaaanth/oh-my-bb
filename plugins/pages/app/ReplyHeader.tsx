import { useEffect, useState, type ComponentType } from "react";
import { experimental_Icon as Icon, useSdk } from "@get-bb/plugin-sdk/app";
import { focusRing } from "./ui.js";
import { replyFor, type Reply, type ReplyThreads } from "./reply.js";

/** What BB passes a message metadata component. Typed here because SDK 0.6.49 predates the slot. */
export type MessageMetadataProps = {
  message: { id: string; threadId: string; createdAt: number; turnId: string | null } & ({ role: "user"; initiator: string } | { role: "assistant" });
};

export type MessageMetadataSlot = (registration: { id: string; placement?: "above" | "actionRow"; component: ComponentType<MessageMetadataProps> }) => void;

/** The rendered card a reply came from, or null when it is not on screen. */
export const sourceCard = (source: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-pages-fence="${CSS.escape(source)}"]`);

function show(source: string): void {
  const card = sourceCard(source);
  if (!card) return;
  card.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  card.animate?.([{ backgroundColor: "var(--color-state-hover, rgba(127,127,127,.15))" }, { backgroundColor: "transparent" }], { duration: 1200, easing: "ease-out" });
}

/** A quote over a user message that a Pages card sent: what it answers, like a chat app's reply. A click scrolls to that card. */
export function ReplyHeader({ message }: MessageMetadataProps) {
  const sdk = useSdk();
  const [reply, setReply] = useState<Reply | null>(null);
  const { id, threadId, createdAt, role } = message;
  useEffect(() => {
    if (role !== "user") return;
    let live = true;
    replyFor(sdk.threads as unknown as ReplyThreads, threadId, id, createdAt)
      .then((found) => { if (live) setReply(found); })
      .catch(() => { /* no header: the message still reads as plain text */ });
    return () => { live = false; };
  }, [sdk, id, threadId, createdAt, role]);
  if (!reply) return null;
  // BB pads the user side of this row (pr-[13px], 11px on touch) to line text up with the bubble's text.
  // A bordered pill should line up with the bubble's edge instead, so the margin cancels that padding.
  return <button type="button" title={reply.quote ? `Reply to: ${reply.quote}` : "Show the card"} onClick={() => show(reply.source)} className={`-mr-[13px] inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-lg border max-md:pointer-coarse:-mr-[11px] border-border-hairline px-2.5 py-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground ${focusRing}`}>
    <Icon name="Reply" fallback="ArrowUp" aria-hidden className="size-3.5 shrink-0" />
    {reply.quote ? <span className="truncate text-foreground">{reply.quote}</span> : "Reply to a card"}
  </button>;
}
