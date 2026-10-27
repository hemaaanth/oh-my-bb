import { useState } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorMessage, message } from "../shared/ui";
import { useRoster } from "./use-roster";

export function ChannelList() {
  const navigate = useBbNavigate();
  const { agents, rooms, activeRoomIds, error } = useRoster(true);
  const [showArchived, setShowArchived] = useState(false);
  const visibleRooms = rooms
    .filter((room) => showArchived || !room.archived)
    .sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned) || right.updatedAt - left.updatedAt);

  return (
    <main className="h-full overflow-auto px-6 py-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input className="size-3.5 accent-foreground" type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            Show archived
          </label>
          <Button size="sm" onClick={() => navigate.toPluginPanel("channels", { subPath: "new" })}>
            <Icon name="Plus" className="size-4" /> New channel
          </Button>
        </div>
        <ErrorMessage error={error} />
        {!visibleRooms.length && !error ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm font-medium">No channels yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Create a channel to work with one or more agents.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {visibleRooms.map((room) => {
              const members = agents.filter((agent) => room.memberIds.includes(agent.id));
              const active = activeRoomIds.includes(room.id);
              return (
                <li key={room.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => navigate.toPluginPanel("channels", { subPath: room.id })}
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${active ? "bg-success" : "bg-muted-foreground/30"}`} aria-label={active ? "Active" : "Idle"} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <strong className="truncate text-sm font-medium">#{room.name}</strong>
                        {room.archived ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Archived</span> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {members.length ? members.map((agent) => agent.name).join(", ") : "No agents"}
                      </span>
                    </span>
                    <span className="flex -space-x-1" aria-label={`${members.length} members`}>
                      {members.slice(0, 4).map((agent) => (
                        <span key={agent.id} className="grid size-6 place-items-center rounded-full border border-card bg-muted text-xs" title={agent.name}>{agent.avatar}</span>
                      ))}
                    </span>
                    <Icon name="ChevronRight" className="size-4 text-muted-foreground" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}

export function CreateChannel() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { agents, error: rosterError } = useRoster();
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [behavior, setBehavior] = useState<"directed" | "smart">("smart");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="h-full overflow-auto px-6 py-5">
      <form
        className="mx-auto w-full max-w-xl space-y-6"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          setPending(true);
          setError(null);
          try {
            const room = await rpc.call("createRoom", {
              ...(name.trim() ? { name: name.trim() } : {}),
              memberIds,
              responseBehavior: behavior,
              requestId: crypto.randomUUID(),
            });
            navigate.toPluginPanel("channels", { subPath: room.id, replace: true });
          } catch (cause) {
            setError(message(cause));
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="All channels" onClick={() => navigate.toPluginPanel("channels")}>
            <Icon name="ChevronLeft" className="size-4" />
          </Button>
          <h1 className="text-base font-medium">Create channel</h1>
        </div>
        <div>
          <label htmlFor="channel-name" className="mb-1.5 block text-xs font-medium text-muted-foreground">Channel name</label>
          <Input id="channel-name" autoFocus maxLength={80} placeholder="New channel" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-muted-foreground">Agents</legend>
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
            {agents.filter((agent) => !agent.retired).map((agent) => {
              const checked = memberIds.includes(agent.id);
              return (
                <label key={agent.id} className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-state-hover">
                  <input
                    className="sr-only"
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setMemberIds((current) => event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id))}
                  />
                  <span className={`grid size-4 shrink-0 place-items-center rounded border ${checked ? "border-foreground bg-foreground text-background" : "border-input"}`} aria-hidden>
                    {checked ? <Icon name="Check" className="size-3" /> : null}
                  </span>
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-sm" aria-hidden>{agent.avatar}</span>
                  <span className="min-w-0 flex-1 text-sm"><strong className="block truncate font-medium">{agent.name}</strong><span className="text-xs text-muted-foreground">@{agent.handle}</span></span>
                </label>
              );
            })}
            {!agents.length ? <p className="px-3 py-4 text-sm text-muted-foreground">Create an agent before inviting one.</p> : null}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-muted-foreground">Mode</legend>
          <div role="radiogroup" aria-label="Channel mode" className="grid grid-cols-2 gap-2">
            {(["directed", "smart"] as const).map((mode) => {
              const selected = behavior === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`flex items-start gap-3 rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${selected ? "border-primary bg-state-active" : "border-border hover:bg-state-hover"}`}
                  onClick={() => setBehavior(mode)}
                >
                  <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-primary" : "border-muted-foreground"}`} aria-hidden>
                    {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
                  </span>
                  <span>
                    <span className="block text-sm font-medium">{mode === "directed" ? "Directed" : "Automatic"}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {mode === "directed" ? "Only mentioned agents respond." : "BB chooses the best available agent."}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
        <ErrorMessage error={error || rosterError} />
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => navigate.toPluginPanel("channels")}>Cancel</Button>
          <Button type="submit" size="sm" disabled={pending}>{pending ? "Creating…" : "Create channel"}</Button>
        </div>
      </form>
    </main>
  );
}
