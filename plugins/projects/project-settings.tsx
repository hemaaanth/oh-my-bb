import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useRpc,
  useRealtime,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import * as Popover from "@radix-ui/react-popover";
import type { rpcContract, ProjectGroupColor } from "./contract";
import { projectGroupColors } from "./group-colors";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./components/ui/dialog";
import { Icon } from "./components/ui/icon";
import { Button } from "./components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./components/ui/select";
import { usePortalScopeProps } from "./lib/portal-scope";
import { EnvironmentEditor } from "./environments/panel";
import { RoutingProfileEditor } from "./routing-editor";

type Organization = PluginRpcResult<
  (typeof rpcContract)["organizationSnapshot"]
>;
type Project = Organization["projects"][number];
type Group = Organization["groups"][number];
export const control =
  "h-9 min-w-0 rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
const colors: Record<ProjectGroupColor, string> = {
  amber: "#fbbf24",
  blue: "#60a5fa",
  violet: "#a78bfa",
  green: "#86efac",
  rose: "#fb7185",
  gray: "#9ca3af",
};
function useOrganization() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Organization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const tail = useRef(Promise.resolve());
  const load = useCallback(async () => {
    const n = ++sequence.current;
    const next = await rpc.call("organizationSnapshot");
    if (n === sequence.current) setData(next);
  }, [rpc]);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
    return () => {
      sequence.current++;
    };
  }, [load]);
  useRealtime("projects-configuration-changed", () => {
    void load().catch((e) => setError(String(e)));
  });
  function run(fn: () => Promise<unknown>) {
    const pending = tail.current.then(async () => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    });
    tail.current = pending.then(() => {});
    return pending;
  }
  return { rpc, data, error, busy, run };
}
function Notice({ data, error }: { data: unknown; error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : !data ? (
    <p role="status" className="text-sm text-muted-foreground">
      Loading…
    </p>
  ) : null;
}
function Modal({
  title,
  description,
  trigger,
  children,
}: {
  title: string;
  description: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(false);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) setVisited(true);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      {visited && (
        <DialogContent className="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-[680px]">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-4">{children}</div>
        </DialogContent>
      )}
    </Dialog>
  );
}
function ColourPicker({
  value,
  onChange,
  label,
  disabled,
}: {
  value: ProjectGroupColor;
  onChange: (v: ProjectGroupColor) => void;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const scope = usePortalScopeProps();
  // Same scoped Radix popover and swatch trigger as Dispatch's colour control.
  // Groups retain their existing named palette, so sidebar colours remain compatible.
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className="flex size-9 shrink-0 items-center justify-center gap-0.5 rounded-md border border-border hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <span
            className="size-5 rounded-full border border-border"
            style={{ backgroundColor: colors[value] }}
          />
          <Icon name="ChevronDown" className="size-2.5" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...scope}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Group colour"
          className="z-[70] flex max-w-[calc(100vw-24px)] flex-wrap gap-2 rounded-md border border-border bg-popover p-3 shadow-md"
        >
          {projectGroupColors.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={value === c}
              className="flex size-9 items-center justify-center rounded-md border border-border focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            >
              <span
                className="flex size-6 items-center justify-center rounded-full"
                style={{ backgroundColor: colors[c] }}
              >
                {value === c && (
                  <Icon
                    name="Check"
                    className="size-4 text-black"
                    aria-hidden
                  />
                )}
              </span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
function GroupRow({
  group,
  busy,
  save,
  remove,
}: {
  group: Group;
  busy: boolean;
  save: (patch: { name?: string; color?: ProjectGroupColor }) => Promise<boolean>;
  remove: () => void;
}) {
  const [name, setName] = useState(group.name);
  const draft = useRef(group.name);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) {
      setName(group.name);
      draft.current = group.name;
    }
  }, [group.name]);
  async function commitName() {
    const sent = draft.current.trim();
    if (!sent) return;
    const ok = await save({ name: sent });
    if (ok && draft.current.trim() === sent) dirty.current = false;
  }
  return (
    <div className="flex min-w-0 items-center gap-3 py-3">
      <ColourPicker
        value={group.color}
        label={`Colour for ${group.name}`}
        onChange={(color) => void save({ color })}
      />
      <input
        aria-label={`Group name: ${group.name}`}
        className={`${control} flex-1`}
        value={name}
        onChange={(e) => {
          dirty.current = true;
          draft.current = e.target.value;
          setName(e.target.value);
        }}
        onBlur={() => {
          if (draft.current.trim() !== group.name) void commitName();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <button
        type="button"
        aria-label={`Delete ${group.name}`}
        title={
          group.isDefault
            ? "The default group cannot be deleted"
            : "Delete group"
        }
        disabled={busy || group.isDefault}
        onClick={remove}
        className={`${control} !px-2 text-destructive disabled:text-muted-foreground`}
      >
        <Icon name="Trash2" className="size-4" aria-hidden />
      </button>
    </div>
  );
}
export function GroupsSettings() {
  const { rpc, data, error, busy, run } = useOrganization();
  const [name, setName] = useState("");
  const [color, setColor] = useState<ProjectGroupColor>("violet");
  return (
    <section className="min-w-0 space-y-4">
      <h2 className="text-sm font-medium">Groups</h2>
      <Notice data={data} error={error} />
      <div className="divide-y divide-border rounded-md border border-border bg-surface-recessed/70 px-3">
        {data?.groups.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            busy={busy}
            save={(patch) =>
              run(() => rpc.call("patchGroup", { id: g.id, ...patch }))
            }
            remove={() => void run(() => rpc.call("deleteGroup", { id: g.id }))}
          />
        ))}
        <form
          className="flex min-w-0 items-center gap-3 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = name.trim();
            if (value)
              void run(() =>
                rpc.call("saveGroup", { name: value, color }),
              ).then((ok) => {
                if (ok)
                  setName((current) =>
                    current.trim() === value ? "" : current,
                  );
              });
          }}
        >
          <ColourPicker
            value={color}
            onChange={setColor}
            label="New group colour"
            disabled={busy}
          />
          <input
            aria-label="New group name"
            placeholder="New group"
            className={`${control} flex-1`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            aria-label="Add group"
            disabled={busy || !data || !name.trim()}
            className={`${control} !px-2`}
          >
            <Icon name="Plus" className="size-4" aria-hidden />
          </button>
        </form>
      </div>
    </section>
  );
}
type Assignments = PluginRpcResult<(typeof rpcContract)["snapshot"]>;
function ProjectDetails({
  project,
  groups,
  busy,
  configured,
  run,
  rpc,
  assignments,
  refreshAssignments,
}: {
  project: Project;
  groups: Group[];
  busy: boolean;
  configured: boolean;
  run: ReturnType<typeof useOrganization>["run"];
  rpc: ReturnType<typeof useOrganization>["rpc"];
  assignments: Assignments | null;
  refreshAssignments: () => Promise<void>;
}) {
  const [tab, setTab] = useState("environment");
  const [iconDraft, setIconDraft] = useState<string | null>(null);
  const selected = assignments?.projects.find((p) => p.id === project.id);
  return (
    <>
      <label className="grid gap-2 text-sm">
        Icon
        <input
          className={control}
          value={iconDraft ?? project.icon}
          onChange={(event) => setIconDraft(event.target.value)}
          aria-label="Project icon"
          onBlur={(e) => {
            const icon = e.target.value.trim();
            if (iconDraft !== null && icon !== project.icon)
              void run(() =>
                rpc.call("updateProject", { projectId: project.id, icon }),
              ).then((ok) => {
                if (ok)
                  setIconDraft((current) =>
                    current?.trim() === icon ? null : current,
                  );
              });
          }}
        />
      </label>
      <label className="flex min-w-0 flex-wrap items-center justify-between gap-3 text-sm">
        Group
        <Select
          value={project.groupId ?? undefined}
          disabled={busy}
          onValueChange={(groupId) =>
            void run(() =>
              rpc.call("setProjectGroup", { projectId: project.id, groupId }),
            )
          }
        >
          <SelectTrigger className="w-48" aria-label="Project group">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <div
        className="flex gap-2"
        role="tablist"
        aria-label="Project configuration"
      >
        {["environment", "routing"].map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === tab}
            className={control}
            onClick={() => setTab(id)}
          >
            {id === "environment" ? "Environment" : "Routing"}
          </button>
        ))}
      </div>
      {selected && assignments && (
        <div className="space-y-3">
          {(
            [
              [
                "Agents",
                assignments.agents.filter(
                  (x) => !assignments.globalAgentIds.includes(x.id),
                ),
                selected.agentIds,
                "setProjectAgent",
              ],
              [
                "Skills",
                assignments.bundles.filter(
                  (x) => !assignments.globalBundleIds.includes(x.id),
                ),
                selected.bundleIds,
                "setProjectBundle",
              ],
            ] as const
          ).map(
            ([label, references, ids, method]) =>
              references.length > 0 && (
                <fieldset key={label} className="space-y-2">
                  <legend className="text-sm font-medium">{label}</legend>
                  {references.map((reference) => (
                    <label
                      key={reference.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={ids.includes(reference.id)}
                        disabled={busy}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          void run(async () => {
                            await rpc.call(method, {
                              projectId: project.id,
                              targetId: reference.id,
                              enabled,
                            });
                            await refreshAssignments();
                          });
                        }}
                      />
                      {reference.name}
                    </label>
                  ))}
                </fieldset>
              ),
          )}
        </div>
      )}
      {tab === "environment" ? (
        <EnvironmentEditor key={project.id} selectedProjectId={project.id} />
      ) : (
        <RoutingProfileEditor
          project={project}
          busy={busy}
          configured={configured}
          onSave={(profile) =>
            run(() =>
              rpc.call("updateRoutingProfile", {
                projectId: project.id,
                ...profile,
              }),
            )
          }
          onGenerate={() =>
            run(() =>
              rpc.call("generateRoutingProfile", { projectId: project.id }),
            )
          }
        />
      )}
    </>
  );
}
export function ProjectsSettings() {
  const { rpc, data, error, busy, run } = useOrganization();
  const [search, setSearch] = useState("");
  const [assignmentText, setAssignmentText] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Assignments | null>(null);
  async function choices() {
    const preferences = await rpc.call("preferences");
    const snapshot = await rpc.call("snapshot");
    const result = [];
    for (const [flag, kind] of [
      [preferences.catalogIntegration, "bundles"],
      [preferences.agentsIntegration, "agentPreferences"],
    ] as const) {
      if (flag) {
        const value = await rpc.call("assignmentOptionsV1", { kind });
        result.push(...value.references.map((x) => x.name));
        if (kind === "bundles") snapshot.bundles = value.references;
        else snapshot.agents = value.references;
      }
    }
    setAssignments(snapshot);
    setAssignmentText(
      result.length
        ? result.join(" · ")
        : "No optional assignment choices enabled. Enable the integration below to load its choices.",
    );
  }
  return (
    <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Projects</h2>
        <input
          type="search"
          aria-label="Search projects"
          placeholder="Search projects"
          className={`${control} w-full sm:w-60`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <Notice data={data} error={error} />
      <div className="max-h-96 overflow-y-auto divide-y divide-border rounded-md border border-border bg-surface-recessed/70 px-3">
        {data?.projects
          .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
          .map((p) => (
            <div
              key={p.id}
              className="flex min-w-0 items-center justify-between gap-3 py-3"
            >
              <span className="flex min-w-0 items-center gap-3">
                {p.icon ? (
                  <span aria-hidden className="w-4 shrink-0 text-center">
                    {p.icon}
                  </span>
                ) : (
                  <Icon
                    name="Folder"
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 truncate text-sm">{p.name}</span>
              </span>
              <Modal
                title={p.name}
                description="Project environment and routing configuration."
                trigger={
                  <button
                    className={`${control} !px-2`}
                    aria-label={`Edit ${p.name}`}
                  >
                    <Icon name="Pencil" className="size-4" aria-hidden />
                  </button>
                }
              >
                <ProjectDetails
                  project={p}
                  groups={data.groups}
                  busy={busy}
                  configured={data.routingConfigured}
                  run={run}
                  rpc={rpc}
                  assignments={assignments}
                  refreshAssignments={async () => {
                    const next = await rpc.call("snapshot");
                    setAssignments((previous) =>
                      previous
                        ? {
                            ...next,
                            agents: previous.agents,
                            bundles: previous.bundles,
                          }
                        : next,
                    );
                  }}
                />
              </Modal>
            </div>
          ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className={control}
          disabled={busy || !data}
          onClick={() => void run(choices)}
        >
          <Icon name="ListFilter" className="mr-2 inline size-4" aria-hidden />
          Load assignment choices
        </button>
        <Modal
          title="Refresh generated profiles"
          description="Creates missing profiles and replaces stale generated profiles. Manual profiles stay unchanged. Uses the saved model and may incur cost."
          trigger={
            <button
              className={control}
              disabled={busy || !data?.routingConfigured}
            >
              <Icon
                name="RefreshCw"
                className="mr-2 inline size-4"
                aria-hidden
              />
              Refresh profiles
            </button>
          }
        >
          <button
            className={control}
            disabled={busy}
            onClick={() =>
              void run(() => rpc.call("generateMissingRoutingProfiles"))
            }
          >
            Refresh stale generated profiles
          </button>
        </Modal>
      </div>
      {assignmentText && (
        <p role="status" className="text-xs text-muted-foreground">
          {assignmentText}
        </p>
      )}
    </section>
  );
}
export function MoreSettings() {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium">More</h2>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-recessed/70 p-3">
        <div className="min-w-0">
          <p className="text-sm">Setup guide</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Setup and usage.
          </p>
        </div>
        <Modal
          title="Set up Projects"
          description="Project configuration, application environments and commands."
          trigger={
            <Button size="sm" variant="outline" className="shrink-0">
              Open setup guide
            </Button>
          }
        >
          <div className="space-y-4 text-sm">
            <p>
              Create and attach projects using BB's native project controls.
              Edit their configuration in the Projects section. Groups organise
              projects and can be used by Status Sidebar.
            </p>
            <p>
              Enter the project's 1Password environment metadata and its scoped
              service-account token under Environment. Metadata and token saves
              do not run project setup.
            </p>
            <p>
              Declare commands and services in the project's{" "}
              <code>bb.json</code>. Existing <code>paseo.json</code> remains a
              fallback. The Scripts thread action runs them on that thread's
              workspace.
            </p>
            <pre className="overflow-x-auto rounded-md border border-border p-3 text-xs">
              {
                '{"scripts":{"test":{"command":"npm test"}}}\n\nbb projects scripts list\nbb projects scripts run test'
              }
            </pre>
            <p>
              Use{" "}
              <code>bb projects scripts agent-setup enable &lt;agent&gt;</code>{" "}
              from a workspace thread to approve its setup. Existing approvals
              and service records are preserved. Setup failure blocks the
              selected agent turn.
            </p>
            <p>
              Keep private setup source in <code>.bb/setup/machine.sh</code> and{" "}
              <code>.bb/setup/workspace.sh</code>. Environment preparation can
              run these scripts. It is separate from saving settings.
            </p>
            <p>
              Routing generation and learning are explicit operations and may
              incur cost. Opening settings does not call a model.
            </p>
          </div>
        </Modal>
      </div>
    </section>
  );
}
