import { useCallback, useEffect, useState } from "react";
import {
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import type { Profile, rpcContract } from "../../server/contract";
import { modelLevelLabel } from "../../server/model-levels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DocumentEditor } from "./document-editor";
import { ProfileForm } from "./profile-form";
import { WorkList } from "./work-list";
import { writeConfigDraft } from "./config-draft";
import { UsagePanel } from "../channels/channel-workbench";
import { IconActionTooltip, Menu } from "../shared/menu";
import { Modal } from "../shared/modal";
import { ResourceListState } from "../shared/resource-list";
import { BackButton, ErrorMessage, TabBar, message } from "../shared/ui";

type AgentActivity = PluginRpcResult<(typeof rpcContract)["agentActivity"]>;
export const agentTabs = ["profile", "mission", "persona", "activity", "usage"] as const;

const scheduleOptions = [
  [30, "Every 30 minutes"],
  [60, "Every hour"],
  [240, "Every 4 hours"],
  [720, "Every 12 hours"],
  [1_440, "Daily"],
] as const;

function scheduleSelection(intervalMinutes: number | null) {
  if (intervalMinutes === null) return "off";
  return scheduleOptions.some(([minutes]) => minutes === intervalMinutes)
    ? String(intervalMinutes)
    : "custom";
}

function scheduleTooltip(intervalMinutes: number | null) {
  if (intervalMinutes === null) return "Mission schedule is off";
  if (intervalMinutes % 1_440 === 0)
    return `Wakes every ${intervalMinutes / 1_440}d`;
  if (intervalMinutes % 60 === 0)
    return `Wakes every ${intervalMinutes / 60}h`;
  return `Wakes every ${intervalMinutes}m`;
}

function nextWakeText(
  agent: AgentActivity["agent"] | undefined,
  now: number,
) {
  if (!agent || agent.intervalMinutes === null) return "Schedule is off.";
  if (agent.retired) return "Retired: restore to run on schedule.";
  if (agent.paused) return "Paused: resume to run on schedule.";
  if (agent.nextWakeAt === null) return "Next wake unavailable.";
  const minutes = Math.max(0, Math.ceil((agent.nextWakeAt - now) / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainder = minutes % 60;
  const parts = [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    remainder || (!days && !hours) ? `${remainder}m` : "",
  ].filter(Boolean);
  return `Next wake in ${parts.join(" ")}`;
}

function MissionSchedule({
  profile,
  agent,
  pending,
  onSave,
}: {
  profile: Profile;
  agent: AgentActivity["agent"] | undefined;
  pending: boolean;
  onSave: (intervalMinutes: number | null) => Promise<void>;
}) {
  const intervalMinutes = agent?.intervalMinutes ?? profile.intervalMinutes;
  const [selection, setSelection] = useState(
    scheduleSelection(intervalMinutes),
  );
  const [customMinutes, setCustomMinutes] = useState(
    String(intervalMinutes ?? 30),
  );
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setSelection(scheduleSelection(intervalMinutes));
    setCustomMinutes(String(intervalMinutes ?? 30));
  }, [intervalMinutes]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const choose = (value: string) => {
    setSelection(value);
    if (value === "custom") return;
    void onSave(value === "off" ? null : Number(value));
  };
  const custom = Number(customMinutes);
  const validCustom = Number.isInteger(custom) && custom >= 15 && custom <= 10_080;

  return (
    <section className="space-y-3 border-b border-border/80 pb-6">
      <div>
        <h2 className="text-sm font-medium text-foreground">Schedule</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          Wake this agent for one bounded mission step. Missed wakes are not replayed.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Interval
          <Select disabled={pending} value={selection} onValueChange={choose}>
            <SelectTrigger className="h-9 w-[14rem]" aria-label="Mission schedule">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              {scheduleOptions.map(([minutes, label]) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {label}
                </SelectItem>
              ))}
              <SelectItem value="custom">Custom…</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {selection === "custom" ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (validCustom) void onSave(custom);
            }}
          >
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Minutes
              <Input
                className="h-9 w-28"
                type="number"
                min={15}
                max={10_080}
                step={1}
                value={customMinutes}
                onChange={(event) => setCustomMinutes(event.target.value)}
              />
            </label>
            <Button type="submit" size="sm" disabled={pending || !validCustom}>
              Save
            </Button>
          </form>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {nextWakeText(agent, now)}
      </p>
    </section>
  );
}


function OpenDm({ profile }: { profile: Profile }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium leading-5 text-foreground">Direct chat</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Open this agent’s permanent DM. It keeps the same thread and memory across visits.
        </p>
      </div>
      <Button type="button" disabled={pending} onClick={() => {
        setPending(true);
        setError(null);
        void rpc.call("ensureAgentDm", { profileId: profile.id })
          .then(({ threadId }) => navigate.toThread(threadId))
          .catch((cause) => setError(message(cause)))
          .finally(() => setPending(false));
      }}>{pending ? "Opening…" : "Open DM"}</Button>
      <ErrorMessage error={error} />
    </section>
  );
}

export function AgentDetail({
  profile,
  tab,
  onReload,
}: {
  profile: Profile;
  tab: (typeof agentTabs)[number];
  onReload: () => void | Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [runProject, setRunProject] = useState<{ id: string; name: string } | null>(null);

  const loadActivity = useCallback(async () => {
    try {
      setActivity(await rpc.call("agentActivity", { id: profile.id }));
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, [profile.id, rpc]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);
  useRealtime("changed", () => {
    void loadActivity();
  });
  useEffect(() => {
    if (!profile.runProjectId) {
      setRunProject(null);
      return;
    }
    let current = true;
    void sdk.projects.get({ projectId: profile.runProjectId })
      .then((project) => { if (current) setRunProject({ id: project.id, name: project.name }); })
      .catch(() => {
        if (current) setRunProject(null);
      });
    return () => {
      current = false;
    };
  }, [profile.runProjectId, sdk]);


  const action = async (request: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await request();
      await loadActivity();
      await onReload();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      await rpc.call("deleteProfile", { id: profile.id });
      writeConfigDraft(`bb:agents:profile:${profile.id}`, null);
      setDeleteOpen(false);
      await onReload();
      navigate.toPluginPanel("agents");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };

  const agent = activity?.agent;
  const missionPaused = !!agent?.paused;
  const visibleTabs = profile.kind === "thin"
    ? agentTabs.filter((candidate) => candidate !== "mission" && candidate !== "persona")
    : agentTabs;
  return (
    <div className="bot-detail">
      <header className="bot-detail-header">
        <div className="bot-detail-title-row">
          <div className="flex min-w-0 items-center gap-3">
            <BackButton />
            <span className="bot-detail-avatar" aria-hidden>{profile.avatar}</span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1>{profile.name}</h1>
                {profile.isDefault ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                    Default
                  </span>
                ) : null}
                {profile.kind === "thin" ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                    Thin
                  </span>
                ) : null}
              </div>
              <p className="truncate text-xs text-subtle-foreground">
                @{profile.slug} · {profile.modelMode === "level" ? modelLevelLabel(profile.level) : profile.model}{profile.runProjectId ? ` · Default project: ${runProject?.name ?? profile.runProjectId}` : ""} · Revision {profile.revision}
              </p>
            </div>
          </div>
          <div className="bot-detail-actions">
            {agent?.retired ? (
              <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                Retired
              </span>
            ) : profile.kind === "full" ? (
              <IconActionTooltip
                label={scheduleTooltip(agent?.intervalMinutes ?? profile.intervalMinutes)}
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  aria-label={missionPaused ? "Resume mission work" : "Pause mission work"}
                  disabled={pending || !agent}
                  onClick={() =>
                    void action(() =>
                      rpc.call("pause", {
                        id: profile.id,
                        paused: !missionPaused,
                      }),
                    )
                  }
                >
                  <Icon name={missionPaused ? "Play" : "Pause"} className="size-3.5" />
                  {missionPaused ? "Mission paused" : "Mission active"}
                </Button>
              </IconActionTooltip>
            ) : null}
            {agent?.error ? (
              <span className="rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
                Needs attention
              </span>
            ) : null}
            <Menu
              label={`${profile.name} actions`}
              open={actionsOpen}
              onOpenChange={setActionsOpen}
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  aria-label={`${profile.name} actions`}
                >
                  <Icon name="MoreHorizontal" className="size-4" />
                </Button>
              }
            >
              {agent?.retired ? (
                <button
                  type="button"
                  className="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-state-hover disabled:opacity-50"
                  disabled={pending}
                  onClick={() => {
                    setActionsOpen(false);
                    void action(() => rpc.call("retire", { id: profile.id, retired: false }));
                  }}
                >
                  <Icon name="RotateCcw" className="size-4" />
                  Restore agent
                </button>
              ) : (
                <button
                  type="button"
                  className="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-state-hover disabled:opacity-50"
                  disabled={pending || !agent}
                  onClick={() => {
                    setActionsOpen(false);
                    setRetireOpen(true);
                  }}
                >
                  <Icon name="Archive" className="size-4" />
                  Retire agent
                </button>
              )}
              <div className="my-1 h-px bg-border" role="separator" />
              <button
                type="button"
                className="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-state-hover disabled:opacity-50"
                disabled={pending}
                onClick={() => {
                  setActionsOpen(false);
                  setDeleteOpen(true);
                }}
              >
                <Icon name="Trash2" className="size-4" />
                Delete agent
              </button>
            </Menu>
          </div>
        </div>
        <div className="bot-detail-tabs-row">
          <TabBar
            items={visibleTabs}
            selected={tab}
            label="Agent sections"
            onSelect={(selected) =>
              navigate.toPluginPanel("agents", {
                subPath: `${profile.id}/${selected}`,
              })
            }
          />
        </div>
      </header>
      <Modal
        title={`Retire ${profile.name}?`}
        open={retireOpen}
        onOpenChange={setRetireOpen}
      >
        <p className="text-sm leading-5">
          This stops the agent’s work and removes it from every channel. Its
          profile, files, and conversation history are preserved.
          {profile.kind === "full" ? " Its mission and persona are preserved too." : ""}
          {" "}You can restore it later.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setRetireOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() =>
              void action(async () => {
                await rpc.call("retire", { id: profile.id, retired: true });
                setRetireOpen(false);
              })
            }
          >
            Retire agent
          </Button>
        </div>
      </Modal>
      <Modal
        title={`Delete ${profile.name}?`}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      >
        <p className="text-sm leading-5">
          This permanently deletes the agent’s unfinished work, channel
          memberships, private history, documents, and files. Agents that have
          authored channel messages cannot be deleted. Promoted visible threads
          remain.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setDeleteOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => void remove()}
          >
            Delete agent
          </Button>
        </div>
      </Modal>
      {(error || agent?.error) ? (
        <div className="bot-error">
          <ErrorMessage error={error || agent?.error || null} />
        </div>
      ) : null}
      <div className="bot-section">
        <div className="bot-config-content">
          {tab === "profile" ? (
            <div className="bot-profile-layout">
              <ProfileForm
                key={profile.id}
                profile={profile}
                onSaved={onReload}
              />
              {profile.showInSidebar ? <OpenDm profile={profile} /> : null}
            </div>
          ) : null}
          {profile.kind === "full" && tab === "mission" ? (
            <div className="space-y-6">
              <MissionSchedule
                profile={profile}
                agent={agent}
                pending={pending}
                onSave={(intervalMinutes) =>
                  action(() =>
                    rpc.call("setMissionSchedule", {
                      id: profile.id,
                      intervalMinutes,
                    }),
                  )}
              />
              <DocumentEditor
                key={`${profile.id}/${tab}`}
                profile={profile}
                file="MISSION.md"
              />
            </div>
          ) : null}
          {profile.kind === "full" && tab === "persona" ? (
            <DocumentEditor
              key={`${profile.id}/${tab}`}
              profile={profile}
              file="PERSONA.md"
            />
          ) : null}
          {tab === "usage" ? (
            <UsagePanel id={profile.id} kind="agent" />
          ) : null}
          {tab === "activity" ? (
            <section className="space-y-3">
              <div className="flex min-h-6 items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">Activity</h2>
                {profile.kind === "full" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || !agent || agent.paused || agent.retired}
                    onClick={() =>
                      void action(() => rpc.call("wake", { id: profile.id }))
                    }
                  >
                    Wake now
                  </Button>
                ) : null}
              </div>
              {activity ? (
                <div className="overflow-hidden rounded-md border border-border bg-background">
                  <WorkList
                    jobs={activity.jobs}
                    agents={agent ? [agent] : []}
                    onCancel={(jobId) =>
                      void action(() => rpc.call("cancelJob", { id: jobId }))
                    }
                  />
                </div>
              ) : (
                <ResourceListState state="loading" message="Loading activity…" loadingRows={3} />
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
