import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { ChannelAgent, Job, RoomMessage } from "../../server/channels/contract";
import type { rpcContract } from "../../server/contract";
import { Button } from "@/components/ui/button";
import { channelWork, channelWorkActivity } from "../shared/channel-work";
import { ErrorMessage, message } from "../shared/ui";
import { GroupComposer } from "./composer";
import { MessageRow } from "./message-row";
import {
  QueuedMessagesList,
  type QueuedMessageAction,
} from "./queued-messages-list";
import { isMissingChannel } from "./channel-path";
import { useChannel } from "./use-channel";
import { useRoster } from "./use-roster";

function MissingChannelState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <span
        className="grid size-10 place-items-center rounded-full bg-muted text-lg text-muted-foreground"
        aria-hidden
      >
        #
      </span>
      <h2 className="mt-3 text-base font-semibold">Channel not found</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        It may have been deleted.
      </p>
      <Button asChild size="sm" variant="outline" className="mt-4">
        <a href="/plugins/agent-profiles/channels">All channels</a>
      </Button>
    </div>
  );
}

type StatusRow = {
  key: string;
  avatar: string | null;
  name: string;
  detail: string;
  job?: Job;
};

// One compact line attached to the composer, like BB's child-thread banner.
// Extra rows (other working agents, delegation waits) sit behind "+N more".
function StatusBanner({
  rows,
  pendingJobId,
  onStop,
}: {
  rows: StatusRow[];
  pendingJobId: string | null;
  onStop: (jobId: string) => void;
}) {
  const navigate = useBbNavigate();
  const [expanded, setExpanded] = useState(false);
  const primary = rows[0];
  if (!primary) return null;
  const openWork = (job?: Job) => {
    if (job?.threadId) navigate.toThread(job.threadId);
  };
  const stop = (job?: Job) =>
    job ? (
      <button
        type="button"
        className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/status-row:opacity-100 disabled:pointer-events-none disabled:opacity-40"
        aria-label="Stop"
        title="Stop"
        disabled={pendingJobId === job.id || !!job.cancellationPending}
        onClick={() => onStop(job.id)}
      >
        <Icon name="Square" className="size-3 fill-current [&_*]:stroke-0" />
      </button>
    ) : null;
  const line = (row: StatusRow) => (
    <button
      type="button"
      className="flex h-7 min-w-0 flex-1 items-center gap-1.5 text-left text-xs disabled:cursor-default"
      disabled={!row.job?.threadId}
      title={`${row.name} · ${row.detail}`}
      onClick={() => openWork(row.job)}
    >
      {row.avatar ? (
        <span className="shrink-0 text-[11px] leading-none" aria-hidden>{row.avatar}</span>
      ) : (
        <Icon name="Spinner" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <span className="shrink-0 font-medium text-foreground/85">{row.name}</span>
      <span className="min-w-0 truncate text-muted-foreground">{row.detail}</span>
    </button>
  );
  return (
    <section
      aria-label="Channel status"
      role="status"
      className="overflow-hidden border border-border bg-surface-raised-solid shadow-lift"
    >
      <div className="group/status-row flex items-center gap-1 px-3">
        {line(primary)}
        {stop(primary.job)}
        {rows.length > 1 ? (
          <button
            type="button"
            className="flex h-7 shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            +{rows.length - 1}
            <Icon name="ChevronDown" className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <ul className="max-h-40 overflow-y-auto border-t border-border/60 px-3 py-0.5">
          {rows.slice(1).map((row) => (
            <li key={row.key} className="group/status-row flex items-center gap-1">
              {line(row)}
              {stop(row.job)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ChannelChat({ id, messageId }: { id: string; messageId?: string }) {
  const {
    data,
    error,
    load,
    loadOlder,
    loadNewer,
    loadAround,
    loadLatest,
    followingLatest,
    loadingPage,
  } = useChannel(id);
  const { agents } = useRoster();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const transcript = useRef<HTMLDivElement>(null);
  const atBottom = useRef(!messageId);
  const scrollAnchor = useRef<{ id: string; top: number } | null>(null);
  const [reply, setReply] = useState<RoomMessage | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const [pendingQueuedAction, setPendingQueuedAction] = useState<{
    jobId: string;
    action: QueuedMessageAction;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(messageId ?? null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  useEffect(() => {
    if (messageId) {
      atBottom.current = false;
      setJumpTarget(messageId);
    }
  }, [messageId]);

  useEffect(() => {
    if (!highlightedMessageId) return;
    const timer = window.setTimeout(() => setHighlightedMessageId(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [highlightedMessageId]);

  const loadHistory = useCallback(async (direction: "older" | "newer") => {
    const container = transcript.current;
    if (!container || loadingPage) return;
    atBottom.current = false;
    followingLatest.current = false;
    const top = container.getBoundingClientRect().top;
    const anchor = Array.from(container.querySelectorAll<HTMLElement>("[data-channel-message]"))
      .find((element) => element.getBoundingClientRect().bottom > top);
    scrollAnchor.current = anchor ? { id: anchor.dataset.channelMessage!, top: anchor.getBoundingClientRect().top } : null;
    try {
      await (direction === "older" ? loadOlder() : loadNewer());
    } catch (cause) {
      scrollAnchor.current = null;
      setFailure(message(cause));
    }
  }, [followingLatest, loadNewer, loadOlder, loadingPage]);

  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    const container = transcript.current;
    if (!anchor || !container) return;
    const element = Array.from(container.querySelectorAll<HTMLElement>("[data-channel-message]"))
      .find((candidate) => candidate.dataset.channelMessage === anchor.id);
    if (element) container.scrollTop += element.getBoundingClientRect().top - anchor.top;
    scrollAnchor.current = null;
  }, [data?.messages]);

  useEffect(() => {
    if (!jumpTarget || !data || loadingPage) return;
    const element = document.getElementById(`channel-message-${jumpTarget}`);
    if (element) {
      element.scrollIntoView({ block: "center" });
      element.focus();
      setHighlightedMessageId(jumpTarget);
      setJumpTarget(null);
      return;
    }
    void loadAround(jumpTarget).catch((cause) => {
      setFailure(message(cause));
      setJumpTarget(null);
    });
  }, [data, jumpTarget, loadAround, loadingPage]);

  useEffect(() => {
    const container = transcript.current;
    if (container && atBottom.current && !jumpTarget) container.scrollTop = container.scrollHeight;
  }, [data?.messages.at(-1)?.id, jumpTarget]);

  if (!data) {
    if (error && isMissingChannel(error)) return <MissingChannelState />;
    return <div className="p-4"><ErrorMessage error={error} />{!error ? <p className="text-sm text-muted-foreground" role="status">Loading channel…</p> : null}</div>;
  }

  const { room, messages, reactions, jobs, runs } = data;
  const queuedJobs = jobs.filter((job) => job.status === "queued");
  const working = channelWork(jobs).filter((job) => job.status !== "queued");
  const choosingAgent = runs.some((run) => run.routing === "pending");
  const agentLabel = (agentId: string) => {
    const agent = agents.find((candidate) => candidate.id === agentId);
    return { avatar: agent?.avatar ?? "🤖", name: agent?.name ?? "Agent", handle: agent ? `@${agent.handle.replace(/^@/u, "")}` : "an agent" };
  };
  const statusRows: StatusRow[] = [
    ...(choosingAgent
      ? [{ key: "routing", avatar: null, name: "Choosing an agent", detail: "" }]
      : []),
    ...working.map((job) => ({
      key: job.id,
      ...agentLabel(job.agentId),
      detail: channelWorkActivity(job),
      job,
    })),
    ...data.delegationWaits.map((wait) => ({
      key: `wait:${wait.requesterAgentId}`,
      ...agentLabel(wait.requesterAgentId),
      detail: `waiting for ${new Intl.ListFormat(undefined, { style: "short", type: "conjunction" }).format(wait.delegateAgentIds.map((id) => agentLabel(id).handle))}`,
    })),
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="mx-auto w-full max-w-[760px] px-4 pt-3">
        <ErrorMessage error={failure || error} />
      </div>
      <div
        ref={transcript}
        className="min-h-0 flex-1 overflow-y-auto"
        role="log"
        aria-label="Channel conversation"
        aria-live="polite"
        onScroll={() => {
          const container = transcript.current;
          if (!container) return;
          const distance =
            container.scrollHeight -
            container.scrollTop -
            container.clientHeight;
          atBottom.current = !data.hasNewer && distance < 100;
          followingLatest.current = atBottom.current;
          if (!loadingPage && !jumpTarget) {
            if (container.scrollTop < 120 && data.hasOlder) {
              void loadHistory("older");
            } else if (distance < 120 && data.hasNewer) {
              void loadHistory("newer");
            }
          }
        }}
      >
        <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col justify-end px-4 pb-3 pt-1">
          {data.hasOlder ? (
            <div className="flex justify-center py-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={loadingPage}
                onClick={() => void loadHistory("older")}
              >
                {loadingPage ? "Loading…" : "Load earlier messages"}
              </Button>
            </div>
          ) : null}
          {jumpTarget ? (
            <p
              role="status"
              className="px-3 py-2 text-center text-xs text-muted-foreground"
            >
              Finding message…
            </p>
          ) : null}
          {!messages.length ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
              <span
                className="grid size-10 place-items-center rounded-full bg-muted text-lg text-muted-foreground"
                aria-hidden
              >
                #
              </span>
              <h2 className="mt-3 text-base font-semibold">{room.name}</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Send a message or mention an agent to start the conversation.
              </p>
            </div>
          ) : null}
          {messages.map((current, index) => {
            const previous = messages[index - 1];
            const parent = current.replyTo
              ? messages.find(
                  (candidate) => candidate.id === current.replyTo,
                ) ??
                data.parents.find(
                  (candidate) => candidate.id === current.replyTo,
                ) ??
                null
              : null;
            const newDay =
              !previous ||
              new Date(previous.createdAt).toLocaleDateString() !==
                new Date(current.createdAt).toLocaleDateString();
            return (
              <div key={current.id}>
                {newDay ? (
                  <div className="my-3 flex items-center gap-3 px-2 text-[10px] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                    }).format(current.createdAt)}
                  </div>
                ) : null}
                <MessageRow
                  message={current}
                  previous={previous}
                  parent={parent}
                  agent={agents.find(
                    (agent) => agent.id === current.agentId,
                  )}
                  agents={agents}
                  job={jobs.find(
                    (job) =>
                      job.id === current.sourceJobId ||
                      job.id === current.id,
                  )}
                  reactions={reactions}
                  highlighted={highlightedMessageId === current.id}
                  onReply={() => setReply(current)}
                  onReact={(emoji) => {
                    const active = reactions.some(
                      (reaction) =>
                        reaction.messageId === current.id &&
                        reaction.emoji === emoji &&
                        reaction.actorId === "user",
                    );
                    void rpc
                      .call("reaction", {
                        id,
                        messageId: current.id,
                        emoji,
                        active: !active,
                      })
                      .then(
                        () => load(),
                        (cause) => setFailure(message(cause)),
                      );
                  }}
                  onJump={(target) => {
                    atBottom.current = false;
                    setJumpTarget(target);
                  }}
                  onImageLoad={() => {
                    const container = transcript.current;
                    if (container && atBottom.current) {
                      container.scrollTop = container.scrollHeight;
                    }
                  }}
                />
              </div>
            );
          })}
          {data.hasNewer ? (
            <div className="flex justify-center py-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={loadingPage}
                onClick={() => void loadHistory("newer")}
              >
                {loadingPage ? "Loading…" : "Load newer messages"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="relative shrink-0 bg-background">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-4 pt-2">
          {data.hasNewer ? (
            <div className="mb-1 flex justify-center">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  atBottom.current = true;
                  void loadLatest();
                }}
              >
                Jump to latest
              </Button>
            </div>
          ) : null}
          <div className="relative z-10 -mb-5 flex flex-col gap-2 empty:hidden [&>*]:rounded-xl [&>*:last-child]:rounded-b-none [&>*:last-child]:border-b-0 [&>*:last-child]:pb-5">
            <QueuedMessagesList
              jobs={queuedJobs}
              agents={agents}
              processing={pendingQueuedAction}
              onAction={(job, action) => {
                setFailure(null);
                setPendingQueuedAction({ jobId: job.id, action });
                const request =
                  action === "delete"
                    ? rpc.call("cancelJob", { id: job.id })
                    : rpc.call("queuedJobAction", {
                        jobId: job.id,
                        action,
                      });
                void request
                  .then(() => load())
                  .catch((cause) => setFailure(message(cause)))
                  .finally(() => setPendingQueuedAction(null));
              }}
            />
            <StatusBanner
              rows={statusRows}
              pendingJobId={pendingJobId}
              onStop={(jobId) => {
                setPendingJobId(jobId);
                void rpc
                  .call("cancelJob", { id: jobId })
                  .then(
                    () => load(),
                    (cause) => setFailure(message(cause)),
                  )
                  .finally(() => setPendingJobId(null));
              }}
            />
          </div>
          <GroupComposer
            autoFocus
            agents={agents}
            jobs={jobs}
            memberIds={room.memberIds}
            roomId={room.id}
            roomName={room.name}
            paused={!!room.archived}
            reply={reply}
            onClearReply={() => setReply(null)}
            onSent={() => {
              atBottom.current = true;
              void loadLatest();
            }}
          />
        </div>
      </div>
    </div>
  );
}
