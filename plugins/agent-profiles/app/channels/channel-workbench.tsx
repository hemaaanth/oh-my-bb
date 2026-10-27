import { useEffect, useState, type ReactNode } from "react";
import {
  useRpc,
  type PluginNavPanelProps,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import { defaultLimits } from "../../server/channels/usage-defaults";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkList } from "../agents/work-list";
import { ResourceListState } from "../shared/resource-list";
import { ErrorMessage, message } from "../shared/ui";
import { channelIdFromSubPath, isMissingChannel } from "./channel-path";
import { DecisionsPanel } from "./channel-decisions-panel";
import { ChannelAutomationsPanel } from "./channel-automations-panel";
import { OutputPanel } from "./channel-output-panel";
import { useChannel } from "./use-channel";
import { useRoster } from "./use-roster";

type Usage = PluginRpcResult<(typeof rpcContract)["usage"]>;

function ActivityPanel({ id }: { id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { data, error, load } = useChannel(id);
  const { agents, error: rosterError } = useRoster(true);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const action = async (jobId: string, request: "cancelJob" | "retryJob") => {
    setPendingJobId(jobId);
    setActionError(null);
    try {
      await rpc.call(request, { id: jobId });
      await load();
    } catch (cause) {
      setActionError(message(cause));
    } finally {
      setPendingJobId(null);
    }
  };

  return (
    <div className="p-3">
      <ErrorMessage error={actionError || (error && !isMissingChannel(error) ? error : null) || rosterError} />
      {!data && error && isMissingChannel(error) ? null : !data ? (
        <ResourceListState state="loading" message="Loading activity…" loadingRows={3} />
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-background">
          <WorkList
            jobs={data.jobs}
            agents={agents}
            pendingJobId={pendingJobId}
            onCancel={(jobId) => void action(jobId, "cancelJob")}
            onRetry={(jobId) => void action(jobId, "retryJob")}
            canRetry={(job) => {
              const agent = agents.find(
                (candidate) => candidate.id === job.agentId,
              );
              return (
                !data.room.archived &&
                data.room.memberIds.includes(job.agentId) &&
                !!agent &&
                !agent.retired
              );
            }}
          />
        </div>
      )}
    </div>
  );
}

export function UsagePanel({
  id,
  kind,
}: {
  id: string;
  kind: "agent" | "channel";
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [limits, setLimits] = useState(defaultLimits);
  const [savedLimits, setSavedLimits] = useState(defaultLimits);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let current = true;
    void rpc.call("usage", { id, kind }).then(
      (next) => {
        if (!current) return;
        setUsage(next);
        setLimits(next.limits);
        setSavedLimits(next.limits);
        setError(null);
      },
      (cause) => {
        if (current) setError(message(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [id, kind, rpc]);

  const fields: Array<[keyof typeof limits, string]> = [
    ["turnsPerHour", "Turns per hour"],
    ["turnsPerDay", "Turns per day"],
    ...(kind === "agent"
      ? ([
          ["minutesPerTurn", "Minutes per turn"],
          ["concurrentForks", "Concurrent forks"],
        ] as Array<[keyof typeof limits, string]>)
      : []),
  ];
  const dirty =
    limits.turnsPerHour !== savedLimits.turnsPerHour ||
    limits.turnsPerDay !== savedLimits.turnsPerDay ||
    limits.minutesPerTurn !== savedLimits.minutesPerTurn ||
    limits.concurrentForks !== savedLimits.concurrentForks;

  return (
    <div className={kind === "channel" ? "space-y-5 p-3" : "space-y-6"}>
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Usage</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Work requested in the last 24 hours. Agent and channel limits both apply.
          </p>
        </div>
        {usage ? (
          <dl className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
            {[
              ["Tasks", usage.turns],
              ["Forks", usage.forks],
              ["Unfinished", usage.active],
              ["Failed", usage.errors],
              ...(kind === "channel"
                ? [
                    ["Classifier calls", usage.routingCalls],
                    [
                      "Classifier time",
                      `${Math.round(usage.routingMilliseconds / 1000)}s`,
                    ],
                  ]
                : []),
            ].map(([label, value]) => (
              <div className="flex min-h-8 items-center justify-between gap-3 px-3 py-1.5" key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-sm font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        ) : !error ? (
          <ResourceListState state="loading" message="Loading usage…" loadingRows={4} />
        ) : null}
      </section>
      <section className="space-y-3 border-t border-border/80 pt-5">
        <div>
          <h2 className="text-sm font-medium text-foreground">Limits</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Counts include started turns. Unfinished includes queued work. Provider billing and token usage remain in View work.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {fields.map(([field, label]) => (
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground" key={field}>
              {label}
              <Input
                className="h-8 text-sm text-foreground"
                type="number"
                min={1}
                aria-label={label}
                value={limits[field]}
                disabled={pending}
                onChange={(event) => {
                  setLimits({ ...limits, [field]: Number(event.target.value) });
                  setNotice("");
                }}
              />
            </label>
          ))}
        </div>
        <ErrorMessage error={error} />
        <div className="flex min-h-8 items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
          <Button
            size="sm"
            disabled={pending || !usage || !dirty}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                const next = await rpc.call("saveLimits", { id, kind, limits });
                setUsage(next);
                setLimits(next.limits);
                setSavedLimits(next.limits);
                setNotice("Limits saved. Queued work uses the new limits.");
              } catch (cause) {
                setError(message(cause));
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Saving…" : "Save limits"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function MissingChannel() {
  return (
    <div className="p-3 text-sm text-muted-foreground">
      Open a channel to see its details.
    </div>
  );
}

// Tabs render only for a channel that exists; a deleted one is explained once in the chat.
function ExistingChannel({ id, children }: { id: string; children: ReactNode }) {
  const { data, error } = useChannel(id, false);
  if (!data) return error && isMissingChannel(error) ? <MissingChannel /> : null;
  return <>{children}</>;
}

// Tab registrations (title, icon, layout) live in workbench-tabs.ts so they
// register at startup while these components load on first use.
export function ChannelActivityTab({ subPath }: PluginNavPanelProps) {
  const id = channelIdFromSubPath(subPath);
  return id ? <ExistingChannel id={id}><ActivityPanel id={id} /></ExistingChannel> : <MissingChannel />;
}

export function ChannelOutputTab({ subPath }: PluginNavPanelProps) {
  const id = channelIdFromSubPath(subPath);
  return id ? <ExistingChannel id={id}><OutputPanel id={id} /></ExistingChannel> : <MissingChannel />;
}

export function ChannelDecisionsTab({ subPath }: PluginNavPanelProps) {
  const id = channelIdFromSubPath(subPath);
  return id ? <ExistingChannel id={id}><DecisionsPanel id={id} /></ExistingChannel> : <MissingChannel />;
}

export function ChannelAutomationsTab({ subPath }: PluginNavPanelProps) {
  const id = channelIdFromSubPath(subPath);
  return id ? <ExistingChannel id={id}><ChannelAutomationsPanel id={id} /></ExistingChannel> : <MissingChannel />;
}

export function ChannelUsageTab({ subPath }: PluginNavPanelProps) {
  const id = channelIdFromSubPath(subPath);
  return id ? <ExistingChannel id={id}><UsagePanel id={id} kind="channel" /></ExistingChannel> : <MissingChannel />;
}
