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
import { HexColorPicker } from "react-colorful";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import "./settings.css";
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
const colors: Record<string, string> = {
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
  fixed = false,
}: {
  title: string;
  description: string;
  trigger: ReactNode;
  children: ReactNode;
  fixed?: boolean;
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
        <DialogContent
          className={`max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-[680px] ${fixed ? "h-[85dvh] !flex !flex-col" : ""}`}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div
            className={`min-w-0 space-y-4 ${fixed ? "flex-1 min-h-0 overflow-y-auto pr-1" : ""}`}
          >
            {children}
          </div>
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
  const [draft, setDraft] = useState(colors[value] ?? value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(colors[value] ?? value);
  }, [value]);
  function commit(hex: string) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (hex !== (colors[value] ?? value)) onChange(hex.toLowerCase());
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          style={{ backgroundColor: colors[value] ?? value }}
          className="size-8 shrink-0 cursor-pointer rounded-md border border-border shadow-sm focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...scope}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Group colour"
          className="projects-colour-picker z-[70] w-64 max-w-[calc(100vw-24px)] space-y-3 rounded-md border border-border bg-popover p-3 shadow-md"
        >
          <HexColorPicker
            color={draft}
            onChange={setDraft}
            onChangeEnd={commit}
            aria-label="Custom colour picker"
          />
          <div className="flex gap-2">
            {projectGroupColors.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                className="size-7 rounded-md border border-border focus-visible:ring-2 focus-visible:ring-ring"
                style={{ backgroundColor: colors[c] }}
                onClick={() => {
                  setDraft(colors[c]);
                  onChange(c);
                  setInvalid(false);
                }}
              />
            ))}
          </div>
          <label className="grid gap-1 text-xs">
            Hex colour
            <input
              aria-label="Hex colour"
              aria-invalid={invalid}
              value={draft}
              maxLength={7}
              spellCheck={false}
              className={control}
              onChange={(e) => {
                setDraft(e.target.value);
                setInvalid(false);
              }}
              onBlur={() => commit(draft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(draft);
                }
              }}
            />
          </label>
          {invalid && (
            <p role="alert" className="text-xs text-destructive">
              Use # followed by six hex digits.
            </p>
          )}
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
  save: (patch: {
    name?: string;
    color?: ProjectGroupColor;
  }) => Promise<boolean>;
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
    <div className="flex min-w-0 items-center gap-3 py-2">
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
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-destructive hover:bg-secondary disabled:text-muted-foreground disabled:opacity-30"
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
          className="flex min-w-0 items-center gap-3 py-2"
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
            className="inline-flex !size-8 shrink-0 items-center justify-center rounded-md !p-0 hover:bg-secondary disabled:opacity-40"
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
}: {
  project: Project;
  groups: Group[];
  busy: boolean;
  configured: boolean;
  run: ReturnType<typeof useOrganization>["run"];
  rpc: ReturnType<typeof useOrganization>["rpc"];
}) {
  const [iconDraft, setIconDraft] = useState<string | null>(null);
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
      <Tabs defaultValue="environment" className="min-w-0">
        <TabsList
          aria-label="Project configuration"
          className="w-full justify-start"
        >
          <TabsTrigger value="environment">Environment</TabsTrigger>
          <TabsTrigger value="routing">Suggestions</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
        </TabsList>
        <TabsContent
          value="environment"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <EnvironmentEditor key={project.id} selectedProjectId={project.id} />
        </TabsContent>
        <TabsContent value="skills">
          <ProjectSkills projectId={project.id} />
        </TabsContent>
        <TabsContent
          value="routing"
          forceMount
          className="data-[state=inactive]:hidden"
        >
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
        </TabsContent>
      </Tabs>
    </>
  );
}
function ProjectSkills({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Assignments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError(null);
    try {
      const [snapshot, options] = await Promise.all([
        rpc.call("snapshot"),
        rpc.call("assignmentOptionsV1", { kind: "bundles" }),
      ]);
      setData({ ...snapshot, bundles: options.references });
    } catch (e) {
      setError(
        "Executor is unavailable. Install or enable Executor to choose skill sets. Your saved assignments are unchanged.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [projectId]);
  const project = data?.projects.find((p) => p.id === projectId);
  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs text-muted-foreground">
        Choose the Executor skill sets available in this project. Global skill
        sets already apply to every project. Changes take effect immediately.
      </p>
      {!data ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? "Loading skill sets…" : "Retry loading skill sets"}
        </Button>
      ) : (
        <div className="space-y-2">
          {data.bundles.map((bundle) => (
            <label key={bundle.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                disabled={busy || data.globalBundleIds.includes(bundle.id)}
                checked={
                  data.globalBundleIds.includes(bundle.id) ||
                  !!project?.bundleIds.includes(bundle.id)
                }
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setBusy(true);
                  setError(null);
                  void rpc
                    .call("setProjectBundle", {
                      projectId,
                      targetId: bundle.id,
                      enabled,
                    })
                    .then(load)
                    .catch((e) => {
                      setError(String(e));
                      setBusy(false);
                    });
                }}
              />
              <span>
                {bundle.name}
                {data.globalBundleIds.includes(bundle.id) && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    Global
                  </span>
                )}
                {bundle.detail && (
                  <span className="block text-xs text-muted-foreground">
                    {bundle.detail}
                  </span>
                )}
              </span>
            </label>
          ))}
          {!data.bundles.length && (
            <p className="text-sm text-muted-foreground">
              No skill sets in Executor.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function ProjectsSettings() {
  const { rpc, data, error, busy, run } = useOrganization();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
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
      <div className="divide-y divide-border rounded-md border border-border bg-surface-recessed/70 px-3">
        {data?.projects
          .filter((p) =>
            `${p.name} ${p.gitRemoteUrl ?? ""}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .slice(0, expanded || search ? undefined : 8)
          .map((p) => (
            <div
              key={p.id}
              className="flex min-w-0 items-center justify-between gap-3 py-2"
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
                <span className="min-w-0 space-y-0.5">
                  <span className="block truncate text-sm font-medium">
                    {p.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.gitRemoteUrl
                      ?.replace(/^https?:\/\//, "")
                      .replace(/^git@([^:]+):/, "$1/")
                      .replace(/\.git$/, "") ??
                      p.localPath ??
                      "No repository"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {data.groups.find((g) => g.id === p.groupId)?.name ??
                      "Ungrouped"}{" "}
                    ·{" "}
                    {p.machineCount
                      ? `${p.machineCount} ${p.machineCount === 1 ? "machine" : "machines"}`
                      : "No machine checkout"}{" "}
                    ·{" "}
                    {p.routingProfile.source === "none"
                      ? "No description"
                      : p.routingProfile.source === "manual"
                        ? "Custom description"
                        : "AI description"}
                  </span>
                </span>
              </span>
              <Modal
                title={p.name}
                fixed
                description="Environment, skills and new-thread project suggestions."
                trigger={
                  <button
                    className="inline-flex !size-8 shrink-0 items-center justify-center rounded-md !p-0 hover:bg-secondary disabled:opacity-40"
                    aria-label={`Edit ${p.name}`}
                  >
                    <Icon name="projects/edit" className="size-4" aria-hidden />
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
                />
              </Modal>
            </div>
          ))}
        {!search && data && data.projects.length > 8 && (
          <button
            className="flex h-8 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon
              name={expanded ? "ChevronUp" : "ChevronDown"}
              className="size-3"
              aria-hidden
            />
            {expanded
              ? "Show fewer projects"
              : `Show all ${data.projects.length} projects`}
          </button>
        )}
      </div>
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
              Project descriptions help the composer suggest a project for a new
              thread. Generating a description is an explicit AI action and may
              incur cost. Opening settings does not call a model.
            </p>
          </div>
        </Modal>
      </div>
    </section>
  );
}
