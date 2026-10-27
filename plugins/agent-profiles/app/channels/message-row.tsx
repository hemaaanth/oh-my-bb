import { useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ChannelAgent, Job, Reaction, RoomMessage } from "../../server/channels/contract";
import { ChannelAttachments } from "../shared/channel-attachments";
import { IconActionTooltip, Menu, ReactionPicker } from "../shared/channel-controls";
import { ChannelMessageContent } from "./artifact-message";

const ACTION_BUTTON_CLASS =
  "inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";
const HOVER_REVEAL_CLASS =
  "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100";
const OVERFLOW_ITEM_CLASS =
  "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function MessageActionButtons({
  message,
  job,
  copied,
  alignment,
  onReact,
  onReply,
  onCopy,
}: {
  message: RoomMessage;
  job?: Job;
  copied: boolean;
  alignment: "start" | "end";
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
}) {
  const navigate = useBbNavigate();
  const workThreadId = job?.threadId ?? message.sourceThreadId;
  const slot = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const node = slot.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < 112);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const actions = [
    {
      key: "reply",
      label: "Reply",
      ariaLabel: `Reply to ${message.speaker}`,
      icon: "CornerDownRight" as const,
      onSelect: onReply,
    },
    {
      key: "copy",
      label: copied ? "Copied" : "Copy",
      ariaLabel: `Copy ${message.speaker}'s message`,
      icon: copied ? ("Check" as const) : ("Copy" as const),
      onSelect: onCopy,
    },
    ...(workThreadId
      ? [{
          key: "work",
          label: "See work",
          ariaLabel: `View ${message.speaker}'s work`,
          icon: "ExternalLink" as const,
          onSelect: () => navigate.toThread(workThreadId),
        }]
      : []),
  ];
  const select = (action: (typeof actions)[number]) => {
    setMenuOpen(false);
    action.onSelect();
  };
  return (
    <div
      ref={slot}
      className={`relative h-5 w-full ${alignment === "end" ? "pr-[13px]" : ""}`}
    >
      <div
        className={`absolute top-0 flex max-w-full items-center gap-2 overflow-hidden ${
          alignment === "end" ? "right-[13px]" : "left-1"
        }`}
      >
        <ReactionPicker
          label="React"
          onReact={onReact}
          triggerClassName={`${ACTION_BUTTON_CLASS} ${HOVER_REVEAL_CLASS}`}
        />
        {!narrow
          ? actions.map((action) => (
              <IconActionTooltip key={action.key} label={action.label}>
                <button
                  type="button"
                  className={`${ACTION_BUTTON_CLASS} ${HOVER_REVEAL_CLASS}`}
                  aria-label={action.ariaLabel}
                  onClick={action.onSelect}
                >
                  <Icon name={action.icon} className="size-3" />
                </button>
              </IconActionTooltip>
            ))
          : (
              <Menu
                label="Message actions"
                open={menuOpen}
                onOpenChange={setMenuOpen}
                className="min-w-32 max-w-64"
                trigger={
                  <button
                    type="button"
                    className={`${ACTION_BUTTON_CLASS} ${HOVER_REVEAL_CLASS} data-[state=open]:text-foreground data-[state=open]:opacity-100`}
                    aria-label="More actions"
                  >
                    <Icon name="MoreHorizontal" className="size-3" />
                  </button>
                }
              >
                {actions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className={OVERFLOW_ITEM_CLASS}
                    onClick={() => select(action)}
                  >
                    <Icon name={action.icon} className="size-3.5" />
                    {action.label}
                  </button>
                ))}
              </Menu>
            )}
      </div>
    </div>
  );
}

export function MessageRow({
  message,
  previous,
  parent,
  agent,
  agents,
  job,
  reactions,
  onReply,
  onReact,
  highlighted,
  onJump,
  onImageLoad,
}: {
  message: RoomMessage;
  previous?: RoomMessage;
  parent: RoomMessage | null;
  agent?: ChannelAgent;
  agents?: readonly ChannelAgent[];
  job?: Job;
  reactions: Reaction[];
  onReply: () => void;
  onReact: (emoji: string) => void;
  onJump: (id: string) => void;
  onImageLoad: () => void;
  highlighted: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.agentId === null && !message.sourceThreadId;
  const compact = !!previous && previous.agentId === message.agentId && previous.sourceThreadId === message.sourceThreadId && previous.speaker === message.speaker && message.createdAt - previous.createdAt < 5 * 60_000 && !message.replyTo;
  const grouped = [...new Set(reactions.filter((reaction) => reaction.messageId === message.id).map((reaction) => reaction.emoji))];
  const markers = [
    ...(job?.returnOf ? ["Follow-up"] : []),
    ...(message.automationId && message.agentId ? ["Scheduled"] : []),
    ...(message.forkSourceThreadId ? ["In parallel"] : []),
    ...(message.saved ? ["Saved decision"] : []),
    ...(message.editedAt ? ["Edited"] : []),
  ];

  if (message.system === "bot_joined") {
    return (
      <div
        id={`channel-message-${message.id}`}
        data-channel-message={message.id}
        className="w-full rounded-md px-2 py-0 text-muted-foreground"
        role="status"
      >
        <span className="flex w-full max-w-full items-center justify-center gap-1.5 py-0 text-xs leading-5">
          <Icon name="UserRoundPlus" className="size-3.5 shrink-0" /> {message.text}
        </span>
      </div>
    );
  }

  return (
    <article
      id={`channel-message-${message.id}`}
      data-channel-message={message.id}
      className={`group/message relative w-full rounded-md transition-[background-color,box-shadow] duration-500 ${compact ? "pt-0" : "pt-2"} ${highlighted ? "bg-primary/10 ring-1 ring-primary/30" : ""}`}
      tabIndex={0}
    >
      <div
        className={
          isUser
            ? "ml-auto flex w-fit max-w-[70%] flex-col items-end max-md:max-w-[86%]"
            : "w-full"
        }
      >
        {!isUser && !compact ? (
          <header className="mb-1 flex items-center gap-1.5 px-2">
            <span
              className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px]"
              aria-hidden
            >
              {agent?.avatar ?? "🤖"}
            </span>
            <strong className="text-xs font-medium text-foreground">
              {agent?.name ?? message.speaker}
            </strong>
            <time
              className="text-[10px] text-muted-foreground"
              dateTime={new Date(message.createdAt).toISOString()}
              title={new Date(message.createdAt).toLocaleString()}
            >
              {new Intl.DateTimeFormat(undefined, {
                hour: "numeric",
                minute: "2-digit",
              }).format(message.createdAt)}
            </time>
          </header>
        ) : null}
        {markers.length ? (
          <div className={`flex items-center gap-1.5 py-0 text-xs leading-5 text-muted-foreground ${isUser ? "justify-end pr-2" : "px-2"}`}>
            <Icon name={message.forkSourceThreadId ? "Fork" : "CornerDownRight"} className="size-3.5 shrink-0" />
            <span>{markers.join(" · ")}</span>
          </div>
        ) : null}
        <div
          className={
            isUser
              ? "max-w-full rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground"
              : "w-full px-2 text-sm font-normal leading-relaxed text-foreground"
          }
        >
          {parent ? (
            <button
              type="button"
              className="mb-2 flex max-w-full items-center gap-1 rounded-r-md border-l-2 border-border bg-surface-recessed px-2 py-1 text-left text-xs text-muted-foreground"
              onClick={() => onJump(parent.id)}
            >
              <Icon name="CornerDownRight" className="size-3.5 shrink-0" />
              <span className="truncate">
                {parent.speaker}: {parent.text.slice(0, 160) || "Attachment"}
              </span>
            </button>
          ) : null}
          {message.text ? <ChannelMessageContent text={message.text} agents={agents} /> : null}
          {message.attachments.length ? (
            <ChannelAttachments
              attachments={message.attachments}
              onImageLoad={onImageLoad}
            />
          ) : null}
          {grouped.length ? (
            <div
              className={`mt-2 flex flex-wrap gap-1 ${isUser ? "justify-end" : ""}`}
            >
              {grouped.map((emoji) => {
                const actors = reactions.filter(
                  (reaction) =>
                    reaction.messageId === message.id &&
                    reaction.emoji === emoji,
                );
                const active = actors.some(
                  (reaction) => reaction.actorId === "user",
                );
                return (
                  <button
                    key={emoji}
                    type="button"
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      active
                        ? "border-ring bg-state-active"
                        : "border-border bg-surface-recessed"
                    }`}
                    aria-pressed={active}
                    title={actors
                      .map((reaction) => reaction.actorName)
                      .join(", ")}
                    onClick={() => onReact(emoji)}
                  >
                    {emoji}{" "}
                    <span className="text-muted-foreground">
                      {actors.length}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <MessageActionButtons
          message={message}
          job={job}
          copied={copied}
          alignment={isUser ? "end" : "start"}
          onReact={onReact}
          onReply={onReply}
          onCopy={() => {
            void navigator.clipboard.writeText(message.text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        />
      </div>
    </article>
  );
}
