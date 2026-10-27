import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { SmilePlusIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ChannelAgent } from "../../server/channels/contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deferred } from "./lazy";

export function Menu({
  trigger,
  children,
  label,
  open,
  onOpenChange,
  className = "",
  tooltip,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  tooltip?: string;
}) {
  const triggerElement = <Popover.Trigger asChild>{trigger}</Popover.Trigger>;
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {tooltip ? (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{triggerElement}</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="z-[80] rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md" side="bottom" sideOffset={6}>
              {tooltip}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      ) : triggerElement}
      <Popover.Portal>
        <Popover.Content
          aria-label={label}
          align="end"
          sideOffset={5}
          collisionPadding={8}
          className={`min-w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md ${className}`}
          style={{ zIndex: 75 }}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function IconActionTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ zIndex: 80 }}
          side="bottom"
          sideOffset={6}
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Modal({
  title,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function matchingAgents(agents: ChannelAgent[], memberIds: string[], query: string) {
  const normalized = query.toLowerCase();
  return agents
    .filter((agent) => !agent.retired)
    .filter((agent) => `${agent.name} ${agent.handle}`.toLowerCase().includes(normalized))
    .sort((left, right) =>
      Number(memberIds.includes(right.id)) - Number(memberIds.includes(left.id)) || left.name.localeCompare(right.name),
    );
}

export function AgentOptions({
  agents,
  memberIds,
  query,
  onSelect,
  onCreate,
  selected,
  listId,
  onHover,
}: {
  agents: ChannelAgent[];
  memberIds: string[];
  query: string;
  onSelect: (agent: ChannelAgent) => void;
  onCreate?: () => void;
  selected?: number;
  listId?: string;
  onHover?: (index: number) => void;
}) {
  const matches = matchingAgents(agents, memberIds, query);
  return (
    <div
      id={listId}
      role="listbox"
      aria-label="Agents"
      className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {matches.map((agent, index) => (
        <button
          key={agent.id}
          id={listId ? `${listId}-${index}` : undefined}
          type="button"
          role="option"
          aria-selected={selected === index}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-state-hover aria-selected:bg-state-hover"
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover?.(index)}
          onClick={() => onSelect(agent)}
        >
          <span className="text-lg" aria-hidden>{agent.avatar}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{agent.name}</span>
            <span className="block truncate text-xs text-muted-foreground">@{agent.handle}</span>
          </span>
          <span className="text-xs text-muted-foreground">{memberIds.includes(agent.id) ? "Added" : "Invite"}</span>
        </button>
      ))}
      {!matches.length ? <p className="px-2 py-3 text-xs text-muted-foreground">No matching agents</p> : null}
      {onCreate ? (
        <button
          type="button"
          id={listId ? `${listId}-${matches.length}` : undefined}
          role="option"
          aria-selected={selected === matches.length}
          className="mt-1 flex w-full items-center gap-2 border-t border-border px-2 py-2 text-left text-sm hover:bg-state-hover aria-selected:bg-state-hover"
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover?.(matches.length)}
          onClick={onCreate}
        >
          <Icon name="Plus" className="size-4" /> Create new agent…
        </button>
      ) : null}
    </div>
  );
}

export function InvitePicker({
  agents,
  memberIds,
  onSelect,
  onCreate,
}: {
  agents: ChannelAgent[];
  memberIds: string[];
  onSelect: (agent: ChannelAgent) => void;
  onCreate?: () => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <>
      <Input autoFocus aria-label="Find an agent" placeholder="Find an agent…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <AgentOptions agents={agents} memberIds={memberIds} query={query} onSelect={onSelect} onCreate={onCreate} />
    </>
  );
}

const EmojiReactionPicker = deferred(() =>
  import("./emoji-reaction-picker").then((module) => module.EmojiReactionPicker),
);

export function ReactionPicker({
  onReact,
  label = "Add reaction",
  triggerClassName,
}: {
  onReact: (emoji: string) => void;
  label?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      label="Choose a reaction"
      open={open}
      onOpenChange={setOpen}
      className="channel-reaction-picker"
      tooltip={label}
      trigger={
        <button
          type="button"
          className={triggerClassName ?? "inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"}
          aria-label={label}
        >
          {/* The host icon set has no smiley; unknown names fall back to another glyph. */}
          <HugeiconsIcon icon={SmilePlusIcon} className="size-3" aria-hidden />
        </button>
      }
    >
      <EmojiReactionPicker
        onPick={(emoji) => {
          onReact(emoji);
          setOpen(false);
        }}
      />
    </Menu>
  );
}
