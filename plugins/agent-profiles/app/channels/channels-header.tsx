import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import type { ChannelAgent, Room } from "../../server/channels/contract";
import type { rpcContract } from "../../server/contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorMessage, message } from "../shared/ui";
import { InvitePicker, Menu, Modal } from "../shared/channel-controls";
import { channelWork } from "../shared/channel-work";
import { channelIdFromSubPath, isMissingChannel } from "./channel-path";
import { useChannel, type ChannelData } from "./use-channel";
import { useRoster } from "./use-roster";

type SearchResult = PluginRpcResult<(typeof rpcContract)["history"]>["messages"][number];

function agentState(agent: ChannelAgent, data: ChannelData) {
  const job = channelWork(data.jobs).find((candidate) => candidate.agentId === agent.id);
  if (job?.status === "running" && job.startedAt) return "Working";
  if (job) return "Waiting";
  if (agent.error) return "Needs attention";
  return "Idle";
}

export function RenameChannel({ room, onClose }: { room: Room; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState(room.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Rename channel" open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending || !name.trim()) return;
          setPending(true);
          setError(null);
          try {
            await rpc.call("updateRoom", { id: room.id, name: name.trim() });
            onClose();
          } catch (cause) {
            setError(message(cause));
          } finally {
            setPending(false);
          }
        }}
      >
        <Input autoFocus aria-label="Channel name" required maxLength={80} value={name} disabled={pending} onFocus={(event) => event.target.select()} onChange={(event) => setName(event.target.value)} />
        <ErrorMessage error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save"}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteChannel({ room, onClose }: { room: Room; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Delete channel?" open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <div className="space-y-4">
        <p className="text-sm leading-5">Permanently delete <strong>#{room.name}</strong>, its messages, reactions, and activity? Agents and their homes are kept. This cannot be undone.</p>
        <ErrorMessage error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await rpc.call("deleteRoom", { id: room.id });
                localStorage.removeItem(`bb:agent-profiles:channel-draft:${room.id}`);
                onClose();
                navigate.toPluginPanel("channels", { replace: true });
              } catch (cause) {
                setError(message(cause));
                setPending(false);
              }
            }}
          >
            {pending ? "Deleting…" : "Delete channel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ChannelSearch({ room, open, onOpenChange }: { room: Room; open: boolean; onOpenChange: (open: boolean) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setError(null);
    }
  }, [open]);
  return (
    <Modal title={`Search #${room.name}`} open={open} onOpenChange={onOpenChange}>
      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!query.trim() || pending) return;
          setPending(true);
          setError(null);
          try {
            const page = await rpc.call("history", { id: room.id, query: query.trim(), limit: 50 });
            setResults(page.messages);
          } catch (cause) {
            setError(message(cause));
          } finally {
            setPending(false);
          }
        }}
      >
        <Input autoFocus aria-label="Search messages" placeholder="Search messages…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Button type="submit" disabled={pending || !query.trim()}>{pending ? "Searching…" : "Search"}</Button>
      </form>
      <ErrorMessage error={error} />
      <div className="mt-3 max-h-80 divide-y divide-border overflow-auto">
        {results.map((result) => (
          <button
            key={result.id}
            type="button"
            className="block w-full px-2 py-2 text-left hover:bg-state-hover"
            onClick={() => {
              onOpenChange(false);
              navigate.toPluginPanel("channels", { subPath: `${room.id}/message/${encodeURIComponent(result.id)}` });
            }}
          >
            <span className="block text-xs font-medium">{result.speaker}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{result.text || "Attachment"}</span>
          </button>
        ))}
        {!pending && query && !results.length && !error ? <p className="px-2 py-4 text-center text-xs text-muted-foreground">No matching messages</p> : null}
      </div>
    </Modal>
  );
}

// The host title bar gives headerContent a non-shrinking slot, so cap the
// channel name to the room left after the host title and our controls.
const HOST_TITLE_ROOM_PX = 140;

function useNameWidth(ready: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const row = root.current?.parentElement?.parentElement?.parentElement;
    if (!root.current || !row) return;
    const measure = () => {
      const own = root.current;
      if (!own) return;
      const name = own.querySelector<HTMLElement>("[data-channel-name]");
      const fixed = own.getBoundingClientRect().width - (name?.getBoundingClientRect().width ?? 0);
      const actions = own.parentElement?.parentElement;
      const siblings = actions ? actions.getBoundingClientRect().width - own.getBoundingClientRect().width : 0;
      setWidth(Math.max(48, row.getBoundingClientRect().width - HOST_TITLE_ROOM_PX - fixed - siblings));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [ready]);
  return { root, width };
}

export function ChannelsHeader({ subPath }: PluginNavPanelProps) {
  const id = channelIdFromSubPath(subPath);
  const { data, error, load } = useChannel(id, false);
  const { root, width: nameWidth } = useNameWidth(!!data);
  const rpc = useRpc<typeof rpcContract>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    setSearchOpen(false);
    setRenameOpen(false);
    setDeleteOpen(false);
    setOptionsOpen(false);
    setFailure(null);
  }, [id]);
  // A missing channel is explained once, in the conversation area.
  if (!data) return error && !isMissingChannel(error) ? <span role="alert" className="text-xs text-destructive">{error}</span> : null;
  const room = data.room;
  const update = async (archived: boolean) => {
    setPending(true);
    setFailure(null);
    try {
      await rpc.call("channelState", { id: room.id, archived });
      setOptionsOpen(false);
      await load();
    } catch (cause) {
      setFailure(message(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div ref={root} className="flex items-center gap-0.5">
      <ChannelBar id={room.id} nameWidth={nameWidth} />
      <Button variant="ghost" size="icon" className="size-8" aria-label="Search channel" onClick={() => setSearchOpen(true)}><Icon name="Search" className="size-4" /></Button>
      <Menu
        label="Channel options"
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        trigger={<Button variant="ghost" size="icon" className="size-8" aria-label="Channel options"><Icon name="MoreHorizontal" className="size-4" /></Button>}
      >
        <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-state-hover" onClick={() => { setOptionsOpen(false); setRenameOpen(true); }}><Icon name="Edit" className="size-4" /> Rename channel</button>
        <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-state-hover" disabled={pending} onClick={() => void update(!room.archived)}><Icon name="Archive" className="size-4" /> {room.archived ? "Restore channel" : "Archive channel"}</button>
        <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-destructive hover:bg-state-hover" onClick={() => { setOptionsOpen(false); setDeleteOpen(true); }}><Icon name="Trash2" className="size-4" /> Delete channel</button>
        <ErrorMessage error={failure} />
      </Menu>
      <ChannelSearch room={room} open={searchOpen} onOpenChange={setSearchOpen} />
      {renameOpen ? <RenameChannel room={room} onClose={() => setRenameOpen(false)} /> : null}
      {deleteOpen ? <DeleteChannel room={room} onClose={() => setDeleteOpen(false)} /> : null}
    </div>
  );
}

// Channel name, members and mode, rendered inside the host title bar.
function ChannelBar({ id, nameWidth }: { id: string; nameWidth: number | null }) {
  const { data, error, load } = useChannel(id, false);
  const { agents } = useRoster();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [membersOpen, setMembersOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!data) return null;
  const room = data.room;
  const members = agents.filter((agent) => room.memberIds.includes(agent.id));
  const act = async (work: () => Promise<unknown>) => {
    setPending(true);
    setFailure(null);
    try {
      await work();
      await load();
    } catch (cause) {
      setFailure(message(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 items-center gap-2 px-1">
        <h1 data-channel-name="" className="max-w-[18rem] truncate text-sm font-medium" style={nameWidth === null ? undefined : { maxWidth: Math.min(288, nameWidth) }} title={`#${room.name}`}>#{room.name}</h1>
        {room.archived ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Archived</span> : null}
      </div>
      <Menu
        label="Channel members"
        open={membersOpen}
        onOpenChange={setMembersOpen}
        trigger={
          <Button variant="ghost" className="h-8 px-2" aria-label={`${members.length} channel members`}>
            <span className="flex -space-x-1">
              {members.slice(0, 4).map((agent) => <span key={agent.id} className="grid size-5 place-items-center rounded-full border border-background bg-muted text-[11px]" title={`${agent.name}: ${agentState(agent, data)}`}>{agent.avatar}</span>)}
            </span>
            <span className="ml-1 text-xs text-muted-foreground">{members.length}</span>
          </Button>
        }
      >
        <div className="max-h-64 overflow-auto">
          {members.map((agent) => (
            <div key={agent.id} className="flex items-center gap-2 px-2 py-2">
              <span className="text-lg" aria-hidden>{agent.avatar}</span>
              <span className="min-w-0 flex-1"><strong className="block truncate text-sm">{agent.name}</strong><span className="block text-xs text-muted-foreground">@{agent.handle} · {agentState(agent, data)}</span></span>
              <Button variant="ghost" size="icon" aria-label={`Remove ${agent.name}`} disabled={pending || !!room.archived} onClick={() => void act(() => rpc.call("member", { id, agentId: agent.id, present: false }))}><Icon name="X" /></Button>
            </div>
          ))}
          {!members.length ? <p className="px-2 py-3 text-xs text-muted-foreground">No agents in this channel.</p> : null}
        </div>
        <button type="button" className="flex w-full items-center gap-2 border-t border-border px-2 py-2 text-left text-sm hover:bg-state-hover" disabled={!!room.archived} onClick={() => { setMembersOpen(false); setInviteOpen(true); }}><Icon name="Plus" className="size-4" /> Add agent</button>
      </Menu>
      <Select
        disabled={pending || !!room.archived}
        value={room.responseBehavior}
        onValueChange={(value) => void act(() => rpc.call("channelState", { id, responseBehavior: value as "directed" | "smart", rememberDefault: true }))}
      >
        <SelectTrigger
          className="h-8 w-auto min-w-24 gap-1 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-state-hover focus:ring-1"
          aria-label="Channel mode"
          title="Automatic: mention an agent to pick it; otherwise Jev picks the one best agent."
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="directed">Directed</SelectItem>
          <SelectItem value="smart">Automatic</SelectItem>
        </SelectContent>
      </Select>
      <ErrorMessage error={failure} />
      <Modal title="Add an agent" open={inviteOpen} onOpenChange={setInviteOpen}>
        <InvitePicker
          agents={agents}
          memberIds={room.memberIds}
          onSelect={(agent) => void act(async () => {
            await rpc.call("member", { id, agentId: agent.id, present: true });
            setInviteOpen(false);
          })}
        />
        <a className="text-xs text-muted-foreground underline underline-offset-2" href="/settings/plugins/agent-profiles">Manage agents in Settings</a>
        <ErrorMessage error={failure} />
      </Modal>
    </div>
  );
}
