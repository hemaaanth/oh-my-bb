import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import type {
  ChannelAutomation,
  ChannelAutomationRunPage,
} from "../../server/channels/automation-contract";
import { Button } from "@/components/ui/button";
import { EmptyStatePanel } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { ErrorMessage, message } from "../shared/ui";
import { AutomationEditor, scheduleDescription } from "./automation-editor";
import { useChannel, useChannelRefresh } from "./use-channel";
import { useRoster } from "./use-roster";

export function ChannelAutomationsPanel({ id }: { id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { data, error: channelError } = useChannel(id);
  const { agents, error: rosterError } = useRoster(true);
  const [editing, setEditing] = useState<
    ChannelAutomation | "new" | null
  >(null);
  const [history, setHistory] = useState<
    (ChannelAutomationRunPage & { automationId: string }) | null
  >(null);
  const [items, setItems] = useState<ChannelAutomation[]>([]);
  const [offset, setOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const request = useRef(0);
  const runKeys = useRef(new Map<string, string>());
  const members = agents.filter(
    (agent) =>
      !agent.retired && data?.room.memberIds.includes(agent.id),
  );

  const load = useCallback(
    async (next = 0) => {
      const sequence = ++request.current;
      setLoading(true);
      try {
        const result = await rpc.call("automationList", {
          channelId: id,
          offset: next,
          limit: 20,
        });
        if (sequence !== request.current) return;
        setItems((current) =>
          next ? [...current, ...result.automations] : result.automations,
        );
        setOffset(result.nextOffset);
        setError(null);
      } catch (cause) {
        if (sequence === request.current) setError(message(cause));
      } finally {
        if (sequence === request.current) setLoading(false);
      }
    },
    [id, rpc],
  );

  const showHistory = useCallback(
    async (automation: ChannelAutomation, cursor?: string) => {
      const sequence = request.current;
      setPending(automation.id);
      setError(null);
      try {
        const page = await rpc.call("automationRuns", {
          channelId: id,
          automationId: automation.id,
          limit: 10,
          ...(cursor ? { cursor } : {}),
        });
        if (sequence !== request.current) return;
        setHistory((previous) => ({
          ...page,
          automationId: automation.id,
          runs:
            cursor && previous?.automationId === automation.id
              ? [...previous.runs, ...page.runs]
              : page.runs,
        }));
      } catch (cause) {
        if (sequence === request.current) setError(message(cause));
      } finally {
        setPending(null);
      }
    },
    [id, rpc],
  );

  useEffect(() => {
    setItems([]);
    setOffset(null);
    setError(null);
    setNotice(null);
    setDeleting(null);
    setHistory(null);
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);

  useChannelRefresh(id, () => {
    if (pending) return;
    void load();
    const selected = items.find(
      (automation) => automation.id === history?.automationId,
    );
    if (selected) void showHistory(selected);
  });

  useEffect(() => {
    if (
      !history ||
      !history.runs.some(
        (run) =>
          run.status === "running" ||
          ["queued", "dispatching", "running"].includes(
            run.responseStatus ?? "",
          ),
      )
    ) {
      return;
    }
    const timer = setInterval(() => {
      const selected = items.find(
        (automation) => automation.id === history.automationId,
      );
      if (!pending && selected && document.visibilityState === "visible")
        void showHistory(selected);
    }, 5_000);
    return () => clearInterval(timer);
  }, [history, items, pending, showHistory]);

  const act = async (
    automation: ChannelAutomation,
    action: "pause" | "resume" | "run" | "delete",
  ) => {
    setPending(automation.id);
    setError(null);
    setNotice(null);
    if (action === "run" && !runKeys.current.has(automation.id))
      runKeys.current.set(automation.id, crypto.randomUUID());
    try {
      if (action === "pause") {
        await rpc.call("automationPause", {
          channelId: id,
          automationId: automation.id,
        });
      } else if (action === "resume") {
        await rpc.call("automationResume", {
          channelId: id,
          automationId: automation.id,
        });
      } else if (action === "delete") {
        await rpc.call("automationDelete", {
          channelId: id,
          automationId: automation.id,
        });
      } else {
        await rpc.call("automationRun", {
          channelId: id,
          automationId: automation.id,
          requestId: runKeys.current.get(automation.id)!,
        });
      }
      runKeys.current.delete(automation.id);
      setDeleting(null);
      setNotice(
        action === "run"
          ? "Run requested. Its reply will appear in this channel."
          : action === "pause"
            ? "Automation paused. Work already running will finish."
            : action === "delete"
              ? "Automation deleted."
              : "Automation resumed.",
      );
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(null);
    }
  };

  if (editing) {
    return (
      <div className="p-3">
        <AutomationEditor
          key={editing === "new" ? "new" : editing.id}
          channelId={id}
          agents={members}
          initial={editing === "new" ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Channel automations</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Schedule one agent to post in this channel. New schedules start paused.
          </p>
        </div>
        <Button
          size="sm"
          disabled={!members.length}
          onClick={() => setEditing("new")}
        >
          New automation
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <ErrorMessage error={error || channelError || rosterError} />
      {!items.length && !loading && !error ? (
        <EmptyStatePanel>
          No automations yet. Create a weekday, daily, hourly, one-time, or custom schedule.
        </EmptyStatePanel>
      ) : null}
      {loading && !items.length ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading automations…
        </p>
      ) : null}
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background empty:hidden">
        {items.map((automation) => {
          const agent = agents.find(
            (candidate) => candidate.id === automation.agentId,
          );
          return (
            <article className="space-y-3 p-3" key={automation.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium text-foreground">
                    {automation.name}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {agent ? `@${agent.handle}` : "Unavailable agent"} · {scheduleDescription(automation)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {automation.nextRunAt
                      ? `Next ${new Date(automation.nextRunAt).toLocaleString()}`
                      : "No next run"}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {automation.enabled ? "Enabled" : "Paused"}
                  <Switch
                    checked={automation.enabled}
                    disabled={pending !== null}
                    onCheckedChange={() =>
                      void act(
                        automation,
                        automation.enabled ? "pause" : "resume",
                      )
                    }
                  />
                </label>
              </div>
              <details>
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Task details
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                  {automation.prompt}
                </p>
                {automation.lastRunAt || automation.lastRunStatus ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Last dispatch: {automation.lastRunAt
                      ? `${new Date(automation.lastRunAt).toLocaleString()} · `
                      : ""}
                    {automation.lastRunStatus ?? "pending"}
                  </p>
                ) : null}
                {automation.lastError ? (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {automation.lastError}
                  </p>
                ) : null}
              </details>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => setEditing(automation)}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => void act(automation, "run")}
                >
                  {pending === automation.id ? "Working…" : "Run now"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => void showHistory(automation)}
                >
                  History
                </Button>
                {deleting === automation.id ? (
                  <>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => void act(automation, "delete")}
                    >
                      Confirm delete
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => setDeleting(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={pending !== null}
                    onClick={() => setDeleting(automation.id)}
                  >
                    Delete
                  </Button>
                )}
              </div>
              {history?.automationId === automation.id ? (
                <section className="space-y-2 border-t border-border pt-3">
                  <h4 className="text-xs font-medium text-foreground">
                    Dispatch and response history
                  </h4>
                  {!history.runs.length ? (
                    <p className="text-xs text-muted-foreground">No runs yet.</p>
                  ) : null}
                  {history.runs.map((run) => (
                    <div
                      className="rounded-md bg-surface-recessed/70 px-3 py-2 text-xs text-muted-foreground"
                      key={run.id}
                    >
                      <p>
                        {new Date(run.startedAt).toLocaleString()} · {run.trigger === "manual" ? "Manual" : "Scheduled"} · {run.status}
                      </p>
                      {run.responseStatus ? (
                        <p className="mt-1">Response: {run.responseStatus}</p>
                      ) : null}
                      {run.responseError ? (
                        <p role="alert" className="mt-1 text-destructive">
                          {run.responseError}
                        </p>
                      ) : null}
                      {run.error ? (
                        <p role="alert" className="mt-1 text-destructive">
                          {run.error}
                        </p>
                      ) : null}
                      {run.skipReason ? <p className="mt-1">{run.skipReason}</p> : null}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {run.responseMessageId ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              navigate.toPluginPanel("channels", {
                                subPath: `${id}/message/${encodeURIComponent(run.responseMessageId!)}`,
                              })
                            }
                          >
                            View response
                          </Button>
                        ) : null}
                        {run.responseThreadId ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate.toThread(run.responseThreadId!)}
                          >
                            Open work
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-1">
                    {history.nextCursor ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending !== null}
                        onClick={() =>
                          void showHistory(automation, history.nextCursor!)
                        }
                      >
                        Earlier runs
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => setHistory(null)}
                    >
                      Hide history
                    </Button>
                  </div>
                </section>
              ) : null}
            </article>
          );
        })}
      </div>
      {offset !== null ? (
        <Button
          variant="ghost"
          disabled={loading || pending !== null}
          onClick={() => void load(offset)}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}
