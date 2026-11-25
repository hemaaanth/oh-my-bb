import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_Icon as PluginIcon,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { ThreadTaskChip } from "./thread-task";
import { ChatMenu, chatTint, useChatPopup, type ChatPopupController, type SidebarThread } from "./task-chats.js";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { taskCommandPaletteActions } from "./command-palette.js";
import { byChatState, byPosition, formatRunAge, isOpenPersonalTask, masonry, needsAttention, organizeTasks, placeTask, runPhaseLabels, statusLabels, taskPriority, type ChatState, type RunPhase, type Task, type TaskUnit } from "./task-layout.js";
import { useTaskDrag, type DropSlot } from "./task-drag.js";
import { MoreSettings } from "./settings";

const tasksIcon = "task-workspaces/tasks";

type Provider = "akiflow" | "linear" | "github";
const providerLabels: Record<Provider, string> = { akiflow: "Akiflow", linear: "Linear", github: "GitHub" };

function ProviderIcon({ provider, className = "size-3.5" }: { provider: Provider; className?: string }) {
  if (provider === "akiflow") return <Icon className={className} name="Calendar" aria-hidden />;
  if (provider === "github") return (
    <svg aria-hidden className={className} fill="currentColor" viewBox="0 0 98 96">
      <path d="M41.4395 69.3848C28.8066 67.8535 19.9062 58.7617 19.9062 46.9902 19.9062 42.2051 21.6289 37.0371 24.5 33.5918 23.2559 30.4336 23.4473 23.7344 24.8828 20.959 28.7109 20.4805 33.8789 22.4902 36.9414 25.2656 40.5781 24.1172 44.4062 23.543 49.0957 23.543 53.7852 23.543 57.6133 24.1172 61.0586 25.1699 64.0254 22.4902 69.2891 20.4805 73.1172 20.959 74.457 23.543 74.6484 30.2422 73.4043 33.4961 76.4668 37.1328 78.0937 42.0137 78.0937 46.9902 78.0937 58.7617 69.1934 67.6621 56.3691 69.2891 59.623 71.3945 61.8242 75.9883 61.8242 81.252V91.2051C61.8242 94.0762 64.2168 95.7031 67.0879 94.5547 84.4102 87.9512 98 70.6289 98 49.1914 98 22.1074 75.9883 0 48.9043 0 21.8203 0 0 22.1074 0 49.1914 0 70.4375 13.4941 88.0469 31.6777 94.6504 34.2617 95.6074 36.75 93.8848 36.75 91.3008V83.6445C35.4102 84.2188 33.6875 84.6016 32.1562 84.6016 25.8398 84.6016 22.1074 81.1563 19.4277 74.7441 18.375 72.1602 17.2266 70.6289 15.0254 70.3418 13.877 70.2461 13.4941 69.7676 13.4941 69.1934 13.4941 68.0449 15.4082 67.1836 17.3223 67.1836 20.0977 67.1836 22.4902 68.9063 24.9785 72.4473 26.8926 75.2227 28.9023 76.4668 31.2949 76.4668 33.6875 76.4668 35.2187 75.6055 37.4199 73.4043 39.0469 71.7773 40.291 70.3418 41.4395 69.3848Z" />
    </svg>
  );
  return (
    <svg aria-hidden className={className} fill="currentColor" viewBox="0 0 100 100">
      <path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z" />
    </svg>
  );
}

type ProjectMappings = {
  projects: Array<{ id: string; name: string; kind: "standard" | "personal" }>;
  sources: Array<{
    key: string;
    label: string;
    provider: "akiflow" | "linear" | "github";
    bbProjectId: string | null;
    automatic: boolean;
  }>;
};
type GitHubRepositories = {
  configured: boolean;
  repositories: Array<{ fullName: string; url: string; enabled: boolean }>;
};
type LinearSources = {
  configured: boolean;
  sources: Array<{
    key: string;
    kind: "team" | "project";
    name: string;
    detail: string | null;
    enabled: boolean;
  }>;
};
type AkiflowSources = {
  configured: boolean;
  sources: Array<{ key: string; name: string; enabled: boolean }>;
};
type ProviderSettings = {
  providers: Array<{ provider: Provider; enabled: boolean; configured: boolean }>;
};
type SandboxPreferences = {
  available: boolean;
  selectedProviderId: string | null;
  effectiveProviderId: string | null;
  effectiveLabel: string | null;
  providers: Array<{ id: string; provider: string; label: string; enabled: boolean; configured: boolean; ready: boolean }>;
};


type TaskPatch = Partial<Pick<Task, "title" | "status" | "projectId" | "effectiveProjectId" | "refs" | "position" | "threadIds">>;
type TasksRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

// One board serves every Tasks surface. It starts from the last saved copy, so the screen
// draws at once, then the server's list replaces it.
const boardKey = "task-workspaces:board:v1";
const hiddenProjectsKey = "task-workspaces:hidden-projects:v1";
const linkedThreadsKey = "task-workspaces:linked-threads:v1";
type Board = {
  tasks: Task[] | null;
  patches: Array<{ key: number; patch: Record<string, TaskPatch> }>;
  drafts: Task[];
  // Project ids hidden from All tasks. Hiding shows at once as a pending entry.
  hiddenProjects: string[];
  hiding: Array<{ key: number; projectId: string; hidden: boolean }>;
  // Every chat that any task links, open or done. Null until the server sends it.
  linkedThreadIds: string[] | null;
  shown: Task[];
  shownHidden: ReadonlySet<string>;
};
let board = showBoard({
  tasks: savedBoard(boardKey), patches: [], drafts: [], hiddenProjects: savedBoard(hiddenProjectsKey) ?? [], hiding: [], linkedThreadIds: savedBoard(linkedThreadsKey),
});
const boardListeners = new Set<() => void>();
let nextPatchKey = 0;

function savedBoard<T>(key: string) {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(saved) ? saved as T[] : null;
  } catch { return null; }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* A full store only costs the next cold start. */ }
}

function showBoard(next: Omit<Board, "shown" | "shownHidden">): Board {
  const tasks = next.tasks ?? [];
  const patched = next.patches.length
    ? tasks.map((task) => next.patches.reduce((shown, entry) => entry.patch[task.id] ? { ...shown, ...entry.patch[task.id] } : shown, task))
    : tasks;
  const shownHidden = new Set(next.hiddenProjects);
  for (const entry of next.hiding) {
    if (entry.hidden) shownHidden.add(entry.projectId);
    else shownHidden.delete(entry.projectId);
  }
  return { ...next, shown: next.drafts.length ? [...patched, ...next.drafts] : patched, shownHidden };
}

function setBoard(change: Partial<Omit<Board, "shown" | "shownHidden">>) {
  board = showBoard({ ...board, ...change });
  for (const listener of boardListeners) listener();
}

function setBoardTasks(tasks: Task[], hiddenProjects = board.hiddenProjects, linkedThreadIds = board.linkedThreadIds) {
  setBoard({ tasks, hiddenProjects, linkedThreadIds });
  save(boardKey, tasks);
  save(hiddenProjectsKey, hiddenProjects);
  if (linkedThreadIds) save(linkedThreadsKey, linkedThreadIds);
}

// One fetch runs at a time. A request during a fetch waits for one more, so it sees later writes.
let fetching: Promise<void> | null = null;
let fetchAgain: Promise<void> | null = null;
function refreshBoard(rpc: TasksRpc): Promise<void> {
  if (fetchAgain) return fetchAgain;
  if (fetching) return fetchAgain = fetching.catch(() => undefined).then(() => { fetchAgain = null; return refreshBoard(rpc); });
  return fetching = rpc.call("boardTasks").then((result) => setBoardTasks(result.tasks, result.hiddenProjectIds, result.linkedThreadIds)).finally(() => { fetching = null; });
}

// Several mounted surfaces hear the same event, so they share one fetch.
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshSoon(rpc: TasksRpc) {
  refreshTimer ??= setTimeout(() => {
    refreshTimer = null;
    void refreshBoard(rpc).catch(boardFailed);
  }, 30);
}

// Without a saved copy, a failed fetch shows an empty board instead of loading forever.
function boardFailed() {
  if (!board.tasks) setBoard({ tasks: [] });
}

// Provider write-backs take hundreds of ms, so a change shows at once as a patch.
// The patch stays until the server's list includes it. One patch can change several tasks,
// such as a new order for Now, so all calls run in one queue.
let mutations = Promise.resolve();
function queueMutation(rpc: TasksRpc, call: () => Promise<unknown>, settle: () => void) {
  mutations = mutations
    .then(call)
    .then(() => refreshBoard(rpc))
    .catch((error) => { toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>); })
    .finally(settle);
}

function mutateBoard(rpc: TasksRpc, patch: Record<string, TaskPatch>, call: () => Promise<unknown>) {
  const key = ++nextPatchKey;
  setBoard({ patches: [...board.patches, { key, patch }] });
  queueMutation(rpc, call, () => setBoard({ patches: board.patches.filter((entry) => entry.key !== key) }));
}

function hideBoardProject(rpc: TasksRpc, projectId: string, hidden: boolean) {
  const key = ++nextPatchKey;
  setBoard({ hiding: [...board.hiding, { key, projectId, hidden }] });
  queueMutation(rpc, () => rpc.call("setProjectHidden", { projectId, hidden }),
    () => setBoard({ hiding: board.hiding.filter((entry) => entry.key !== key) }));
}

// A new task shows at once as a draft row. The created task replaces it.
// With a threadId, the task is made for that chat and links it. With a priority, it starts in Now or Later.
const isDraft = (task: Task) => task.id.startsWith("draft:");
function createBoardTask(rpc: TasksRpc, projectId: string, destinationId: string, title: string, threadId?: string, priority?: NewTaskPriority) {
  const draft: Task = {
    id: `draft:${++nextPatchKey}`, identifier: "", title, status: "todo", projectId, effectiveProjectId: projectId,
    threadIds: threadId ? [threadId] : [], owner: { isMe: true }, position: null, refs: priority ? [{ priority, url: null }] : [],
  };
  const withoutDraft = () => board.drafts.filter((item) => item !== draft);
  setBoard({ drafts: [...board.drafts, draft] });
  rpc.call("createProjectTask", { projectId, destinationId, title, ...(threadId ? { threadId } : {}), ...(priority ? { priority } : {}) }).then((created) => {
    setBoard({ drafts: withoutDraft() });
    setBoardTasks([...(board.tasks ?? []).filter((task) => task.id !== created.id), created]);
  }, (error) => {
    setBoard({ drafts: withoutDraft() });
    toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
  });
}

function useTasks(reportErrors = false) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const shown = useSyncExternalStore(
    useCallback((listener: () => void) => { boardListeners.add(listener); return () => { boardListeners.delete(listener); }; }, []),
    () => board,
  );
  useEffect(() => {
    if (connection !== "connected") return;
    if (!reportErrors) { refreshSoon(rpc); return; }
    void refreshBoard(rpc).catch((error) => {
      boardFailed();
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    });
  }, [connection, rpc, reportErrors]);
  useRealtime("tasks-changed", useCallback(() => {
    if (connection === "connected") refreshSoon(rpc);
  }, [connection, rpc]));
  const mutate = useCallback((patch: Record<string, TaskPatch>, call: () => Promise<unknown>) => mutateBoard(rpc, patch, call), [rpc]);
  // A new title shows at once. The server writes it to every linked source.
  const rename = useCallback((task: Task, title: string) =>
    mutateBoard(rpc, { [task.id]: { title } }, () => rpc.call("renameTask", { taskId: task.id, title })), [rpc]);
  const hideProject = useCallback((projectId: string, hidden: boolean) => hideBoardProject(rpc, projectId, hidden), [rpc]);
  return { rpc, tasks: shown.shown, loading: shown.tasks === null, mutate, rename, hiddenProjects: shown.shownHidden, hideProject, linkedThreadIds: shown.linkedThreadIds };
}

function SettingsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [mappings, setMappings] = useState<ProjectMappings>({ projects: [], sources: [] });
  const [github, setGithub] = useState<GitHubRepositories>({ configured: false, repositories: [] });
  const [linear, setLinear] = useState<LinearSources>({ configured: false, sources: [] });
  const [akiflow, setAkiflow] = useState<AkiflowSources>({ configured: false, sources: [] });
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>({ providers: [] });
  const [sandboxPrefs, setSandboxPrefs] = useState<SandboxPreferences | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshingGithub, setRefreshingGithub] = useState(false);
  const [refreshingLinear, setRefreshingLinear] = useState(false);
  const [refreshingAkiflow, setRefreshingAkiflow] = useState(false);
  const [akiflowQuery, setAkiflowQuery] = useState("");
  const [linearQuery, setLinearQuery] = useState("");
  const load = useCallback(async () => {
    const [nextMappings, nextGithub, nextLinear, nextProviderSettings, nextAkiflow, nextSandboxPrefs] = await Promise.all([
      rpc.call("projectMappings"),
      rpc.call("githubRepositories"),
      rpc.call("linearSources"),
      rpc.call("providerSettings"),
      rpc.call("akiflowSources"),
      rpc.call("sandboxPreferences").catch(() => null),
    ]);
    setMappings(nextMappings);
    setGithub(nextGithub);
    setLinear(nextLinear);
    setProviderSettings(nextProviderSettings);
    setAkiflow(nextAkiflow);
    setSandboxPrefs(nextSandboxPrefs);
  }, [rpc]);
  useEffect(() => { void load().catch((error) => toast.error(<span data-bb-demo-sensitive>{String(error)}</span>)); }, [load]);
  useRealtime("tasks-changed", () => { void load().catch((error) => toast.error(<span data-bb-demo-sensitive>{String(error)}</span>)); });

  async function map(sourceKey: string, projectId: string) {
    if (!mappings.projects.some((project) => project.id === projectId)) return;
    setBusy(sourceKey);
    try {
      setMappings(await rpc.call("setProjectMapping", { sourceKey, projectId: projectId || null }));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setBusy(null);
    }
  }

  async function refreshGithub() {
    setRefreshingGithub(true);
    try {
      setGithub(await rpc.call("refreshGithubRepositories"));
      setMappings(await rpc.call("projectMappings"));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setRefreshingGithub(false);
    }
  }

  async function toggleGithubRepository(fullName: string, enabled: boolean) {
    setBusy(`github:${fullName}`);
    try {
      setGithub(await rpc.call("setGithubRepositoryEnabled", { fullName, enabled }));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setBusy(null);
    }
  }

  async function refreshLinear() {
    setRefreshingLinear(true);
    try {
      setLinear(await rpc.call("refreshLinearSources"));
      setMappings(await rpc.call("projectMappings"));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setRefreshingLinear(false);
    }
  }

  async function toggleLinearSource(key: string, enabled: boolean) {
    setBusy(key);
    try {
      setLinear(await rpc.call("setLinearSourceEnabled", { key, enabled }));
      setMappings(await rpc.call("projectMappings"));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setBusy(null);
    }
  }

  async function toggleAllLinearSources(enabled: boolean) {
    setBusy("linear:all");
    try {
      setLinear(await rpc.call("setAllLinearSourcesEnabled", { enabled }));
      setMappings(await rpc.call("projectMappings"));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setBusy(null);
    }
  }

  async function refreshAkiflow() {
    setRefreshingAkiflow(true);
    try {
      setAkiflow(await rpc.call("refreshAkiflowSources"));
      setMappings(await rpc.call("projectMappings"));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setRefreshingAkiflow(false);
    }
  }

  async function toggleAkiflowSource(key: string, enabled: boolean) {
    setBusy(key);
    try {
      setAkiflow(await rpc.call("setAkiflowSourceEnabled", { key, enabled }));
      setMappings(await rpc.call("projectMappings"));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setBusy(null);
    }
  }

  async function toggleAllAkiflowSources(enabled: boolean) {
    setBusy("akiflow:all");
    try {
      setAkiflow(await rpc.call("setAllAkiflowSourcesEnabled", { enabled }));
      setMappings(await rpc.call("projectMappings"));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setBusy(null);
    }
  }

  async function toggleProvider(provider: Provider, enabled: boolean) {
    setBusy(`provider:${provider}`);
    try {
      setProviderSettings(await rpc.call("setProviderEnabled", { provider, enabled }));
      const [nextMappings, nextGithub, nextLinear, nextAkiflow] = await Promise.all([
        rpc.call("projectMappings"),
        rpc.call("githubRepositories"),
        rpc.call("linearSources"),
        rpc.call("akiflowSources"),
      ]);
      setMappings(nextMappings);
      setGithub(nextGithub);
      setLinear(nextLinear);
      setAkiflow(nextAkiflow);
      toast.success(`${providerLabels[provider]} ${enabled ? "enabled" : "disabled"}`);
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setBusy(null);
    }
  }

  const mappingByKey = new Map(mappings.sources.map((source) => [source.key, source]));
  const githubRepositories = github.repositories.map((repository) => ({
    repository,
    source: mappingByKey.get(`github:repo:${repository.fullName.toLowerCase()}`),
  }));
  const synchronizedGithub = githubRepositories.filter(({ repository }) => repository.enabled);
  const unsynchronizedGithub = githubRepositories.filter(({ repository }) => !repository.enabled);
  const synchronizedLinear = linear.sources.filter((source) => source.enabled);
  const normalizedLinearQuery = linearQuery.trim().toLocaleLowerCase();
  const unsynchronizedLinear = linear.sources.filter((source) => !source.enabled && (!normalizedLinearQuery
    || `${source.name} ${source.detail ?? ""} ${source.kind}`.toLocaleLowerCase().includes(normalizedLinearQuery)));
  const synchronizedAkiflow = akiflow.sources.filter((source) => source.enabled);
  const normalizedAkiflowQuery = akiflowQuery.trim().toLocaleLowerCase();
  const unsynchronizedAkiflow = akiflow.sources.filter((source) => !source.enabled
    && (!normalizedAkiflowQuery || source.name.toLocaleLowerCase().includes(normalizedAkiflowQuery)));
  const providerState = new Map(providerSettings.providers.map((state) => [state.provider, state]));
  const akiflowEnabled = providerState.get("akiflow")?.enabled ?? false;
  const githubEnabled = providerState.get("github")?.enabled ?? false;
  const linearEnabled = providerState.get("linear")?.enabled ?? false;

  function providerHeader(provider: Provider, description: string) {
    const state = providerState.get(provider);
    const enabled = state?.enabled ?? false;
    return (
      <div className={`flex items-start justify-between gap-3 p-3 ${enabled ? "border-b border-border/60" : ""}`}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderIcon className="size-4" provider={provider} />
            <h3 className="text-sm font-medium">{providerLabels[provider]}</h3>
            {enabled && !state?.configured ? <span className="text-xs text-muted-foreground">Add a credential in Configuration</span> : null}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        <Switch
          aria-label={`${enabled ? "Disable" : "Enable"} ${providerLabels[provider]}`}
          checked={enabled}
          disabled={!state || busy !== null}
          onCheckedChange={() => void toggleProvider(provider, !enabled)}
        />
      </div>
    );
  }

  function projectSelect(source: ProjectMappings["sources"][number]) {
    return (
      <Select
        value={source.bbProjectId ?? ""}
        onValueChange={(value) => void map(source.key, value)}
        disabled={busy === source.key}
      >
        <SelectTrigger data-bb-demo-label aria-label={`bb project for ${source.label}`} className="h-7 px-2 text-xs">
          <SelectValue placeholder="Map to a bb project…" />
        </SelectTrigger>
        <SelectContent>
          {mappings.projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              <span data-bb-demo-sensitive>{project.kind === "personal" ? "Projectless" : project.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  async function chooseSandboxProvider(value: string) {
    const providerId = value === "__auto__" ? null : value;
    setBusy("sandbox-provider");
    try {
      setSandboxPrefs(await rpc.call("setDefaultSandboxProvider", { providerId }));
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setBusy(null);
    }
  }

  const readySandboxes = sandboxPrefs?.providers.filter((entry) => entry.ready) ?? [];

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium">Preferences</h2>
      {sandboxPrefs?.available ? <section className="overflow-hidden rounded-md border border-border bg-surface-recessed/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">Default sandbox</h3>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {readySandboxes.length
                ? `Used by default when starting factory runs from Tasks. Live options come from your configured Sandboxes providers.${sandboxPrefs.effectiveLabel ? ` Active default: ${sandboxPrefs.effectiveLabel}.` : ""}`
                : "No sandbox providers are currently enabled and configured in the Sandboxes plugin."}
            </p>
          </div>
          {readySandboxes.length ? <div className="w-52 shrink-0">
            <Select
              value={sandboxPrefs.selectedProviderId ?? "__auto__"}
              onValueChange={(value) => void chooseSandboxProvider(value)}
              disabled={busy === "sandbox-provider"}
            >
              <SelectTrigger aria-label="Default sandbox provider" className="h-8 px-2.5 text-xs">
                <SelectValue placeholder="Auto (Boat first)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">Auto (Boat first)</SelectItem>
                {readySandboxes.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div> : null}
        </div>
      </section> : null}
      <section className="overflow-hidden rounded-md border border-border bg-surface-recessed/70">
        {providerHeader("akiflow", "Choose projects to sync.")}
        {akiflowEnabled ? <div className="space-y-3 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Akiflow projects</p>
              <p className="text-sm text-muted-foreground">Only checked projects and Inbox sync to Tasks.</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button className="h-7 px-2" variant="ghost" size="sm" disabled={!akiflow.sources.length || busy !== null} onClick={() => void toggleAllAkiflowSources(true)}>All</Button>
              <Button className="h-7 px-2" variant="ghost" size="sm" disabled={!akiflow.sources.length || busy !== null} onClick={() => void toggleAllAkiflowSources(false)}>None</Button>
              <Button className="h-7 px-2" variant="outline" size="sm" disabled={!akiflow.configured || refreshingAkiflow} onClick={() => void refreshAkiflow()}>
                {refreshingAkiflow ? "Refreshing…" : "Refresh Akiflow"}
              </Button>
            </div>
          </div>
          {!akiflow.configured ? <p className="text-sm text-muted-foreground">Add an Akiflow refresh token in Configuration.</p> : <>
            {synchronizedAkiflow.length ? <div className="divide-y divide-border-hairline rounded-md border border-border-hairline">
              {synchronizedAkiflow.map((source) => {
                const mapping = mappingByKey.get(source.key);
                return <div key={source.key} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 px-2.5 py-2 text-sm md:grid-cols-[minmax(0,1fr)_minmax(12rem,1fr)] md:items-center">
                  <label className="flex min-w-0 items-center gap-2">
                    <Checkbox data-bb-demo-label aria-label={`Synchronize Akiflow ${source.name}`} className="size-3.5 shrink-0" checked disabled={busy !== null}
                      onCheckedChange={(checked) => void toggleAkiflowSource(source.key, checked === true)} />
                    <span className="truncate"><span data-bb-demo-sensitive>{source.name}</span></span>
                  </label>
                  {source.key === "akiflow:inbox"
                    ? <span className="text-xs text-muted-foreground">Projectless</span>
                    : mapping ? projectSelect(mapping) : null}
                </div>;
              })}
            </div> : <p className="text-sm text-muted-foreground">No Akiflow projects are synchronized.</p>}
            <details className="rounded-md border border-border-hairline">
              <summary className="cursor-pointer px-2.5 py-2 text-sm text-muted-foreground hover:bg-state-hover">
                Unsynchronized Akiflow sources ({akiflow.sources.length - synchronizedAkiflow.length})
              </summary>
              <div className="border-t border-border-hairline p-2">
                <Input data-bb-demo-sensitive aria-label="Filter Akiflow projects" className="mb-2 h-8" placeholder="Filter projects…" value={akiflowQuery} onChange={(event) => setAkiflowQuery(event.target.value)} />
                <div className="max-h-72 divide-y divide-border-hairline overflow-auto">
                  {unsynchronizedAkiflow.map((source) => <label key={source.key} className="flex min-w-0 items-center gap-2 px-1 py-2 text-sm hover:bg-state-hover">
                    <Checkbox data-bb-demo-label aria-label={`Synchronize Akiflow ${source.name}`} className="size-3.5 shrink-0" checked={false} disabled={busy !== null}
                      onCheckedChange={(checked) => void toggleAkiflowSource(source.key, checked === true)} />
                    <span className="min-w-0 flex-1 truncate"><span data-bb-demo-sensitive>{source.name}</span></span>
                  </label>)}
                  {!unsynchronizedAkiflow.length ? <p className="px-2 py-6 text-center text-sm text-muted-foreground">No matching unsynchronized sources.</p> : null}
                </div>
              </div>
            </details>
          </>}
        </div> : null}
      </section>
      <section className="overflow-hidden rounded-md border border-border bg-surface-recessed/70">
        {providerHeader("github", "Choose repositories to sync.")}
        {githubEnabled ? <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium">GitHub repositories</p>
            <p className="text-sm text-muted-foreground">
              Checked repositories sync their open issues. Choose where their agent workspaces are created.
            </p>
          </div>
          <Button className="h-7 px-2" variant="outline" size="sm" disabled={!github.configured || refreshingGithub} onClick={() => void refreshGithub()}>
            {refreshingGithub ? "Refreshing…" : "Refresh repositories"}
          </Button>
        </div>
        {!github.configured ? (
          <p className="text-sm text-muted-foreground">Add a GitHub token in the secret field above.</p>
        ) : github.repositories.length ? (
          <div className="space-y-2">
            {synchronizedGithub.length ? (
              <div className="divide-y divide-border-hairline rounded-md border border-border-hairline">
                {synchronizedGithub.map(({ repository, source }) => (
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 px-2.5 py-2 text-sm hover:bg-state-hover md:grid-cols-[minmax(0,1fr)_minmax(12rem,1fr)] md:items-center" key={repository.fullName}>
                    <div className="flex min-w-0 items-center gap-2">
                      <Checkbox data-bb-demo-label
                        aria-label={`Synchronize ${repository.fullName}`}
                        className="size-3.5 shrink-0"
                        checked
                        disabled={busy === `github:${repository.fullName}`}
                        onCheckedChange={(checked) => void toggleGithubRepository(repository.fullName, checked === true)}
                      />
                      <UrlLink className="truncate hover:underline" href={repository.url}><span data-bb-demo-sensitive>{repository.fullName}</span></UrlLink>
                      {source?.automatic ? <span className="text-xs text-muted-foreground">automatic</span> : null}
                    </div>
                    {source ? projectSelect(source) : <span className="text-xs text-muted-foreground">Sync to discover its project mapping.</span>}
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-muted-foreground">No repositories are synchronized.</p>}
            {unsynchronizedGithub.length ? (
              <details className="rounded-md border border-border-hairline">
                <summary className="cursor-pointer px-2.5 py-2 text-sm text-muted-foreground hover:bg-state-hover">
                  Unsynchronized repositories ({unsynchronizedGithub.length})
                </summary>
                <div className="max-h-64 divide-y divide-border-hairline overflow-auto border-t border-border-hairline">
                  {unsynchronizedGithub.map(({ repository }) => (
                    <div className="flex items-center gap-2 px-2.5 py-2 text-sm hover:bg-state-hover" key={repository.fullName}>
                      <Checkbox data-bb-demo-label
                        aria-label={`Synchronize ${repository.fullName}`}
                        className="size-3.5 shrink-0"
                        checked={false}
                        disabled={busy === `github:${repository.fullName}`}
                        onCheckedChange={(checked) => void toggleGithubRepository(repository.fullName, checked === true)}
                      />
                      <UrlLink className="truncate hover:underline" href={repository.url}><span data-bb-demo-sensitive>{repository.fullName}</span></UrlLink>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Refresh to discover repositories.</p>
        )}
        </div> : null}
      </section>
      <section className="overflow-hidden rounded-md border border-border bg-surface-recessed/70">
        {providerHeader("linear", "Choose teams and projects to sync.")}
        {linearEnabled ? <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Linear teams and projects</p>
            <p className="text-sm text-muted-foreground">
              Only checked sources exist in Tasks. Selecting a team includes all issues in that team; select projects for a narrower sync.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button className="h-7 px-2" variant="ghost" size="sm" disabled={!linear.sources.length || busy !== null} onClick={() => void toggleAllLinearSources(true)}>All</Button>
            <Button className="h-7 px-2" variant="ghost" size="sm" disabled={!linear.sources.length || busy !== null} onClick={() => void toggleAllLinearSources(false)}>None</Button>
            <Button className="h-7 px-2" variant="outline" size="sm" disabled={!linear.configured || refreshingLinear} onClick={() => void refreshLinear()}>
              {refreshingLinear ? "Refreshing…" : "Refresh Linear"}
            </Button>
          </div>
        </div>
        {!linear.configured ? (
          <p className="text-sm text-muted-foreground">Add a Linear API key in the secret field above.</p>
        ) : linear.sources.length ? (
          <div className="space-y-2">
            {synchronizedLinear.length ? (
              <div className="divide-y divide-border-hairline rounded-md border border-border-hairline">
                {synchronizedLinear.map((linearSource) => {
                  const mapping = mappingByKey.get(linearSource.key);
                  return (
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 px-2.5 py-2 text-sm hover:bg-state-hover md:grid-cols-[minmax(0,1fr)_minmax(12rem,1fr)] md:items-center" key={linearSource.key}>
                      <div className="flex min-w-0 items-center gap-2">
                        <Checkbox data-bb-demo-label
                          aria-label={`Synchronize Linear ${linearSource.kind} ${linearSource.name}`}
                          className="size-3.5 shrink-0"
                          checked
                          disabled={busy !== null}
                          onCheckedChange={(checked) => void toggleLinearSource(linearSource.key, checked === true)}
                        />
                        <span className="truncate"><span data-bb-demo-sensitive>{linearSource.name}</span></span>
                        <span className="shrink-0 rounded border border-border-hairline px-1 text-[10px] uppercase text-muted-foreground">{linearSource.kind}</span>
                        {linearSource.detail ? <span className="truncate text-xs text-muted-foreground"><span data-bb-demo-sensitive>{linearSource.detail}</span></span> : null}
                      </div>
                      {mapping ? projectSelect(mapping) : <span className="text-xs text-muted-foreground">Mapping will appear after this source is saved.</span>}
                    </div>
                  );
                })}
              </div>
            ) : <p className="text-sm text-muted-foreground">No Linear teams or projects are synchronized.</p>}
            <details className="rounded-md border border-border-hairline">
              <summary className="cursor-pointer px-2.5 py-2 text-sm text-muted-foreground hover:bg-state-hover">
                Unsynchronized Linear sources ({linear.sources.length - synchronizedLinear.length})
              </summary>
              <div className="border-t border-border-hairline p-2">
                <Input data-bb-demo-sensitive
                  aria-label="Filter Linear teams and projects"
                  className="mb-2 h-8"
                  placeholder="Filter teams and projects…"
                  value={linearQuery}
                  onChange={(event) => setLinearQuery(event.target.value)}
                />
                <div className="max-h-72 divide-y divide-border-hairline overflow-auto">
                  {unsynchronizedLinear.map((linearSource) => (
                    <label className="flex items-center gap-2 px-1 py-2 text-sm hover:bg-state-hover" key={linearSource.key}>
                      <Checkbox data-bb-demo-label
                        aria-label={`Synchronize Linear ${linearSource.kind} ${linearSource.name}`}
                        className="size-3.5 shrink-0"
                        checked={false}
                        disabled={busy !== null}
                        onCheckedChange={(checked) => void toggleLinearSource(linearSource.key, checked === true)}
                      />
                      <span className="min-w-0 flex-1 truncate"><span data-bb-demo-sensitive>{linearSource.name}</span></span>
                      {linearSource.detail ? <span className="max-w-48 truncate text-xs text-muted-foreground"><span data-bb-demo-sensitive>{linearSource.detail}</span></span> : null}
                      <span className="shrink-0 rounded border border-border-hairline px-1 text-[10px] uppercase text-muted-foreground">{linearSource.kind}</span>
                    </label>
                  ))}
                  {!unsynchronizedLinear.length ? <p className="px-2 py-6 text-center text-sm text-muted-foreground">No matching unsynchronized sources</p> : null}
                </div>
              </div>
            </details>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Refresh Linear to discover teams and projects.</p>
        )}
        </div> : null}
      </section>
      <p className="text-xs text-muted-foreground">Off removes local tasks. Re-enable and sync to restore.</p>
    </div>
  );
}

function FinishTaskInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = interaction.payload && typeof interaction.payload === "object" && !Array.isArray(interaction.payload)
    ? interaction.payload as Record<string, unknown>
    : {};
  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-recessed/70 p-3">
      <div>
        <p className="font-medium"><span data-bb-demo-sensitive>{String(payload.title ?? "Task")}</span></p>
        <p className="text-sm text-muted-foreground">The pull request merged. Mark this task done and archive its environment?</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void submit({ decision: "done" })}>Done & archive</Button>
        <Button variant="outline" onClick={() => void submit({ decision: "keep" })}>Keep working</Button>
        <Button variant="ghost" onClick={() => void cancel()}>Decide later</Button>
      </div>
    </div>
  );
}

function ArchivedTaskPrompt() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [task, setTask] = useState<Pick<Task, "id" | "identifier" | "title" | "status"> | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const prompt = await rpc.call("archivePrompt");
    setTask(prompt);
  }, [rpc]);
  useEffect(() => {
    if (connection === "connected") void load().catch(() => undefined);
  }, [connection, load]);
  useRealtime("archive-task-prompt", useCallback(() => {
    if (connection === "connected") void load().catch(() => undefined);
  }, [connection, load]));

  const answer = async (decision: "done" | "keep") => {
    if (!task || busy) return;
    setBusy(true);
    try {
      await rpc.call("answerArchived", { taskId: task.id, decision });
      await load();
      if (decision === "done") toast.success(`${task.title || task.identifier} marked done`);
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
    } finally {
      setBusy(false);
    }
  };

  if (!task) return null;
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent className="[&>button.absolute]:hidden" onEscapeKeyDown={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Complete attached task?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground"><span data-bb-demo-sensitive>{task.title || task.identifier}</span></span> is in <span className="font-medium text-foreground">{task.status}</span>. Should the task be marked complete?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void answer("keep")}>No, leave in {task.status}</Button>
          <Button disabled={busy} onClick={() => void answer("done")}>Yes, mark complete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}



const priorityLabels: Record<ReturnType<typeof taskPriority>, string> = { urgent: "Now", high: "Later", medium: "Medium", low: "Low", none: "No priority" };

function StatusGlyph({ status, highlighted = false }: { status: Task["status"]; highlighted?: boolean }) {
  const slice = status === "doing" ? "M7 7V3.5A3.5 3.5 0 0 1 7 10.5Z" : status === "review" ? "M7 7V3.5A3.5 3.5 0 1 1 3.5 7Z" : status === "done" ? "M7 3.5A3.5 3.5 0 1 1 7 10.5A3.5 3.5 0 1 1 7 3.5Z" : null;
  const tone = highlighted ? "text-blue-500" : status === "blocked" ? "text-destructive-text" : slice ? "text-foreground" : "text-subtle-foreground";
  return <span title={statusLabels[status]} className={`flex size-4 shrink-0 items-center justify-center ${tone}`}>
    <svg role="img" aria-label={statusLabels[status]} viewBox="0 0 14 14" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="6" strokeDasharray={status === "backlog" || status === "triage" ? "2 2" : undefined} />
      {slice ? <path d={slice} fill="currentColor" stroke="none" /> : null}
      {status === "blocked" ? <path d="M4.5 7h5" strokeLinecap="round" /> : null}
    </svg>
  </span>;
}

function StatusPicker({ task, onStage, onResolveProposal }: {
  task: Task;
  onStage: (status: Task["status"]) => void;
  onResolveProposal: (accept: boolean) => void;
}) {
  const proposed = task.run?.proposedStatus ?? null;
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setHover = (next: boolean, delay: number) => (event: { pointerType: string }) => {
    if (!proposed || event.pointerType !== "mouse") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const label = proposed
    ? `${statusLabels[task.status]} — suggested: ${statusLabels[proposed]}`
    : `Change stage (${statusLabels[task.status]})`;
  return <DropdownMenu open={open} onOpenChange={(next) => { if (timer.current) clearTimeout(timer.current); setOpen(next); }} modal={false}>
    <span data-no-drag="" title={label} className="flex shrink-0">
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${task.title}`}
          onClick={(event) => event.stopPropagation()}
          onPointerEnter={setHover(true, 100)}
          onPointerLeave={setHover(false, 180)}
          className={`flex size-6 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring ${
            proposed
              ? "bg-blue-500/15 ring-2 ring-blue-500/60 hover:bg-blue-500/25"
              : "hover:bg-state-hover"
          }`}
        >
          <StatusGlyph status={task.status} highlighted={Boolean(proposed)} />
        </button>
      </DropdownMenuTrigger>
    </span>
    <DropdownMenuContent
      data-no-drag=""
      data-bb-demo-label
      align="start"
      mobileTitle={task.title}
      className="min-w-44"
      onPointerEnter={setHover(true, 0)}
      onPointerLeave={setHover(false, 180)}
    >
      {proposed ? <>
        <DropdownMenuLabel className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
          Suggested stage: {statusLabels[proposed]}
        </DropdownMenuLabel>
        <DropdownMenuItem className="text-blue-600 dark:text-blue-400" onSelect={() => onResolveProposal(true)}>
          <Icon name="Check" className="size-3.5" aria-hidden />Move to {statusLabels[proposed]}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onResolveProposal(false)}>
          <Icon name="X" className="size-3.5" aria-hidden />Keep {statusLabels[task.status]}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </> : null}
      {menuStages.map((value) => (
        <MenuChoice key={value} current={value === task.status} onSelect={() => onStage(value)}>
          <span aria-hidden className="flex"><StatusGlyph status={value} /></span>
          {statusLabels[value]}
        </MenuChoice>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function RowAction({ label, icon, task, onClick, disabled }: {
  label: string; icon: "ArrowUp" | "Clock"; task: Task; onClick: () => void; disabled?: boolean;
}) {
  return <span title={label} className="flex">
    <Button data-bb-demo-label aria-label={`${label}: ${task.title}`} variant="ghost" size="icon" disabled={disabled} className="size-7 text-muted-foreground" onClick={onClick}><Icon name={icon} className="size-4" aria-hidden /></Button>
  </span>;
}

type Priority = ReturnType<typeof taskPriority>;
const menuPriorities: Priority[] = ["urgent", "high", "medium", "low", "none"];
const menuStages: Task["status"][] = ["triage", "backlog", "todo", "doing", "blocked", "review", "done"];
type TaskMoves = {
  priority: (task: Task, priority: Priority) => void;
  stage: (task: Task, status: Task["status"]) => void;
  project: (task: Task, projectId: string) => void;
};

// The compact drawer has no submenus, so there each group lists under a label.
function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return useIsCompactViewport()
    ? <><DropdownMenuSeparator /><DropdownMenuLabel>{label}</DropdownMenuLabel>{children}</>
    : <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 min-w-40 overflow-y-auto">{children}</DropdownMenuSubContent>
    </DropdownMenuSub>;
}

function MenuChoice({ current, onSelect, children }: { current: boolean; onSelect: () => void; children: ReactNode }) {
  return <DropdownMenuItem role="menuitemradio" aria-checked={current} onSelect={current ? undefined : onSelect}>
    {children}{current ? <Icon name="Check" className="ml-auto size-3.5" aria-hidden /> : null}
  </DropdownMenuItem>;
}

type MenuProps = { task: Task; projects: ReadonlyArray<{ id: string; name: string }>; moves: TaskMoves };

function TaskMenuContent({ task, projects, moves, align }: MenuProps & { align: "start" | "end" }) {
  const priority = taskPriority(task);
  const projectId = task.effectiveProjectId ?? task.projectId;
  return <DropdownMenuContent data-bb-demo-label align={align} mobileTitle={task.title} className="min-w-36">
    <MenuGroup label="Priority">{menuPriorities.map((value) => <MenuChoice key={value} current={value === priority} onSelect={() => moves.priority(task, value)}>{priorityLabels[value]}</MenuChoice>)}</MenuGroup>
    <MenuGroup label="Stage">{menuStages.map((value) => <MenuChoice key={value} current={value === task.status} onSelect={() => moves.stage(task, value)}><span aria-hidden className="flex"><StatusGlyph status={value} /></span>{statusLabels[value]}</MenuChoice>)}</MenuGroup>
    <MenuGroup label="Project">{projects.map((project) => <MenuChoice key={project.id} current={project.id === projectId} onSelect={() => moves.project(task, project.id)}><span className="truncate"><span data-bb-demo-sensitive>{project.name}</span></span></MenuChoice>)}</MenuGroup>
    <DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive" onSelect={() => moves.stage(task, "cancelled")}><Icon name="Trash2" className="size-3.5" aria-hidden />Delete</DropdownMenuItem>
  </DropdownMenuContent>;
}

function TaskMenu(props: MenuProps) {
  return <DropdownMenu>
    <span title="More actions" className="flex"><DropdownMenuTrigger asChild>
      <Button data-bb-demo-label aria-label={`More actions: ${props.task.title}`} variant="ghost" size="icon" className="size-7 text-muted-foreground"><Icon name="MoreHorizontal" className="size-4" aria-hidden /></Button>
    </DropdownMenuTrigger></span>
    <TaskMenuContent {...props} align="end" />
  </DropdownMenu>;
}

// Right-click opens a menu pinned to a zero-size point under the pointer.
// It is not modal, so a right-click on another row moves the menu there.
function PointMenu({ at, onClose, children }: { at: { x: number; y: number }; onClose: () => void; children: ReactNode }) {
  return <DropdownMenu open modal={false} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DropdownMenuTrigger asChild><span aria-hidden className="pointer-events-none fixed" style={{ left: at.x, top: at.y }} /></DropdownMenuTrigger>
    {children}
  </DropdownMenu>;
}

type RowHandle = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
};
const draggable = "select-none [-webkit-touch-callout:none]";

// One click on a title does nothing. A second click soon after edits it in place, and so does
// the keyboard. Enter or leaving the field saves. Escape cancels. While editing, the text is
// underlined and the caret is the accent color, so the row keeps its look.
// A click opens the task's chats once no second click follows. Two clicks edit the title.
// A tap does not always count clicks, so this wait also decides for taps.
const doubleClickMs = 300;

function TaskTitle({ title, onRename, onOpen, className, clamp }: {
  title: string; onRename: (title: string) => void; onOpen?: () => void; className: string; clamp: string;
}) {
  const [editing, setEditing] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);
  useEffect(() => {
    if (!editing) return;
    finished.current = false;
    field.current?.focus();
    field.current?.select();
  }, [editing]);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = field.current?.value.replace(/\s+/g, " ").trim() ?? "";
    setEditing(false);
    if (save && next && next !== title) onRename(next);
  };
  if (editing) return <textarea data-bb-demo-sensitive ref={field} data-no-drag="" aria-label="Task title" defaultValue={title} rows={1} maxLength={500}
    className={`${className} field-sizing-content resize-none select-text bg-transparent caret-primary underline decoration-primary underline-offset-4 outline-none selection:bg-primary/30 selection:text-foreground`}
    onKeyDown={(event) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    }}
    onBlur={() => finish(true)} />;
  // Enter opens the chats, or edits a task without any. F2 always edits.
  return <button data-bb-demo-label type="button" title={title} className={`${className} cursor-default rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring`} onClick={(event) => {
    if (event.detail === 0) return onOpen ? onOpen() : setEditing(true);
    if (pending.current || event.detail >= 2) {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
      setEditing(true);
    } else pending.current = setTimeout(() => { pending.current = null; onOpen?.(); }, doubleClickMs);
  }} onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); setEditing(true); } }}><span className={clamp}><span data-bb-demo-sensitive>{title}</span></span></button>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function proofHref(proofPageId: string | null | undefined): string | null {
  const value = proofPageId?.trim();
  if (!value) return null;
  if (UUID_RE.test(value)) return `/plugins/pages/pages/${encodeURIComponent(value.toLowerCase())}`;
  if (/^https?:\/\//iu.test(value)) return value;
  return null;
}

function proofEmbedUrl(proofPageId: string | null | undefined): string | null {
  const value = proofPageId?.trim();
  if (!value) return null;
  if (UUID_RE.test(value)) {
    const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    return `/api/v1/plugins/pages/http/p?id=${encodeURIComponent(value.toLowerCase())}&theme=${dark ? "dark" : "light"}`;
  }
  if (/^https?:\/\//iu.test(value)) return value;
  return null;
}

const phasePillClasses: Record<RunPhase, string> = {
  scoping: "border-border/70 bg-muted/70 text-muted-foreground",
  building: "border-blue-500/25 bg-blue-500/12 text-blue-600 dark:text-blue-400",
  capturing: "border-violet-500/25 bg-violet-500/12 text-violet-600 dark:text-violet-400",
  checking: "border-cyan-500/25 bg-cyan-500/12 text-cyan-600 dark:text-cyan-400",
  waiting: "border-amber-500/30 bg-amber-500/12 text-amber-600 dark:text-amber-400",
  babysitting: "border-indigo-500/25 bg-indigo-500/12 text-indigo-600 dark:text-indigo-400",
  deploying: "border-teal-500/25 bg-teal-500/12 text-teal-600 dark:text-teal-400",
  live: "border-emerald-500/25 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  blocked: "border-destructive/30 bg-destructive/12 text-destructive-text",
};

function RunInlineBadge({ task, onOpenProof, unitsOpen, onToggleUnits }: {
  task: Task;
  onOpenProof?: (task: Task, unitId?: string) => void;
  unitsOpen?: boolean;
  onToggleUnits?: () => void;
}) {
  const phase = task.run?.phase ?? null;
  const units = task.run?.units ?? null;
  const doneUnits = units ? units.filter((unit) => unit.status === "done").length : 0;
  const hasProof = Boolean(proofEmbedUrl(task.run?.proofPageId));
  if (!phase && !hasProof && !units?.length) return null;
  return <span data-no-drag="" className="flex shrink-0 items-center gap-1.5">
    {units?.length && onToggleUnits ? <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onToggleUnits(); }}
      title={`${doneUnits} of ${units.length} units done`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-surface-recessed/70 px-2 py-0.5 text-[11px] font-medium tabular-nums leading-4 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
    >
      <span>{doneUnits}/{units.length}</span>
      <Icon name={unitsOpen ? "ChevronDown" : "ChevronRight"} className="size-3" aria-hidden />
    </button> : null}
    {phase ? <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${phasePillClasses[phase]}`}>
      {runPhaseLabels[phase]}
    </span> : null}
    {hasProof && onOpenProof && !units?.length ? <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onOpenProof(task); }}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface-recessed/80 px-2 py-0.5 text-[11px] font-medium leading-4 text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name="Eye" className="size-3 text-muted-foreground" aria-hidden />
      Proof
    </button> : null}
  </span>;
}

function UnitStatusIcon({ status }: { status: TaskUnit["status"] }) {
  if (status === "done") return <Icon name="Check" className="size-3.5 shrink-0 text-emerald-500" aria-hidden />;
  if (status === "waiting") return <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />;
  if (status === "active") return <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-blue-500" />;
  if (status === "blocked") return <Icon name="Clock" className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />;
  return <span aria-hidden className="size-2 shrink-0 rounded-full border border-muted-foreground/50" />;
}

function TaskUnitsList({ task, units, onOpenProof, onApproveProof }: {
  task: Task;
  units: TaskUnit[];
  onOpenProof: (task: Task, unitId?: string) => void;
  onApproveProof: (task: Task, unitId?: string) => void;
}) {
  return <ul aria-label={`${task.title} units`} className="border-t border-border/50 bg-surface-recessed/40 divide-y divide-border/40">
    {units.map((unit) => {
      const hasProof = Boolean(proofEmbedUrl(unit.proofPageId));
      const waiting = unit.status === "waiting";
      const muted = unit.status === "blocked" || unit.status === "pending";
      return <li key={unit.id} className="flex min-w-0 items-center gap-2.5 py-1.5 pe-3 ps-9 text-xs">
        <span className="flex size-4 shrink-0 items-center justify-center"><UnitStatusIcon status={unit.status} /></span>
        <span className={`min-w-0 flex-1 truncate ${unit.status === "done" ? "text-muted-foreground line-through decoration-muted-foreground/40" : muted ? "text-muted-foreground" : "text-foreground"}`}>
          <span data-bb-demo-sensitive>{unit.title}</span>
        </span>
        <span data-no-drag="" className="flex shrink-0 items-center gap-1.5">
          {unit.status === "blocked" && unit.blockedBy ? <span className="inline-flex shrink-0 items-center rounded-full border border-border/60 bg-muted/60 px-2 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground">
            Blocked by {unit.blockedBy}
          </span> : unit.phase ? <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4 ${phasePillClasses[unit.phase]}`}>
            {runPhaseLabels[unit.phase]}
          </span> : null}
          {hasProof ? <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onOpenProof(task, unit.id); }}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background/80 px-2 py-0.5 text-[10px] font-medium leading-4 text-foreground transition-colors hover:bg-state-hover"
          >
            <Icon name="Eye" className="size-2.5 text-muted-foreground" aria-hidden />
            Proof
          </button> : null}
          {waiting && task.threadIds.length > 0 ? <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onApproveProof(task, unit.id); }}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium leading-4 text-primary-foreground transition-opacity hover:opacity-90"
          >
            Approve
          </button> : null}
        </span>
      </li>;
    })}
  </ul>;
}

const proofWidthKey = "task-workspaces:proof-panel-width";

function readProofWidth(): number | null {
  try {
    const raw = Number(localStorage.getItem(proofWidthKey));
    return Number.isFinite(raw) && raw >= 420 ? raw : null;
  } catch { return null; }
}

function ProofSidePanel({ task, unit, onClose, onApproveProof, onResolveProposal }: {
  task: Task;
  unit?: TaskUnit | null;
  onClose: () => void;
  onApproveProof: (task: Task, unitId?: string) => void;
  onResolveProposal: (task: Task, accept: boolean) => void;
}) {
  const compact = useIsCompactViewport();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pageId = unit?.proofPageId ?? task.run?.proofPageId;
  const embedUrl = proofEmbedUrl(pageId);
  const fullHref = proofHref(pageId);
  const external = fullHref ? /^https?:\/\//iu.test(fullHref) : false;
  const proposed = task.run?.proposedStatus === "done" && task.status !== "done" ? "done" : null;
  const awaitingProofApproval = (unit ? unit.status === "waiting" : task.run?.phase === "waiting") && Boolean(embedUrl) && task.threadIds.length > 0;
  const [panelWidth, setPanelWidth] = useState<number | null>(() => readProofWidth());
  const [resizing, setResizing] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const depthRef = useRef(0);

  // Single source of truth for overlay history depth:
  //   0 = Tasks board, 1 = Proof overlay, 2 = Full-screen image Lightbox.
  // Both Android Back and tapping Done/X simply step history back by 1, and popstate
  // reconciles UI strictly from `event.state.__bbProofDepth` — eliminating every race.
  const closeOverlay = useCallback(() => {
    if (typeof window !== "undefined" && depthRef.current > 0) {
      window.history.go(-depthRef.current);
      return;
    }
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (!embedUrl || typeof window === "undefined") return;
    const baseState = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
    window.history.pushState({ ...baseState, __bbProofDepth: 1 }, "");
    depthRef.current = 1;
    setLightboxOpen(false);

    const onPopState = (event: PopStateEvent) => {
      const nextDepth = Number((event.state as { __bbProofDepth?: unknown } | null)?.__bbProofDepth ?? 0);
      if (nextDepth >= 2) {
        depthRef.current = 2;
        setLightboxOpen(true);
        return;
      }
      if (nextDepth === 1) {
        const wasLightbox = depthRef.current >= 2;
        depthRef.current = 1;
        setLightboxOpen(false);
        if (wasLightbox) iframeRef.current?.contentWindow?.postMessage({ type: "bb-pages:lightbox-close" }, "*");
        return;
      }
      depthRef.current = 0;
      setLightboxOpen(false);
      onCloseRef.current();
    };

    const onMessage = (event: MessageEvent) => {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const data = event.data as { type?: unknown; open?: unknown } | null;
      if (data?.type !== "bb-pages:lightbox" || typeof data.open !== "boolean") return;
      if (data.open && depthRef.current === 1) {
        const current = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
        window.history.pushState({ ...current, __bbProofDepth: 2 }, "");
        depthRef.current = 2;
        setLightboxOpen(true);
      } else if (!data.open && depthRef.current === 2) {
        // Step back from depth 2 → 1; onPopState reconciles depthRef & lightboxOpen cleanly.
        window.history.back();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && depthRef.current === 1) closeOverlay();
    };

    window.addEventListener("popstate", onPopState);
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown);
      if (depthRef.current > 0) {
        const steps = depthRef.current;
        depthRef.current = 0;
        window.history.go(-steps);
      }
    };
  }, [embedUrl, closeOverlay]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const minW = 420;
    const maxW = Math.max(minW, window.innerWidth - 48);
    setResizing(true);
    let latest = panelWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.round(Math.min(maxW, Math.max(minW, window.innerWidth - moveEvent.clientX)));
      latest = next;
      setPanelWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (latest !== null) {
        try { localStorage.setItem(proofWidthKey, String(latest)); } catch { /* ignore */ }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const resetWidth = () => {
    setPanelWidth(null);
    try { localStorage.removeItem(proofWidthKey); } catch { /* ignore */ }
  };
  if (!embedUrl) return null;
  const label = unit ? `${task.title} — ${unit.title}` : task.title;

  const actionControls = <>
    {awaitingProofApproval ? <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => onApproveProof(task, unit?.id)}>
      {unit ? "Approve unit" : "Approve & merge"}
    </Button> : proposed ? <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => onResolveProposal(task, true)}>
      Mark {statusLabels[proposed]}
    </Button> : null}
    {fullHref ? <span title="Open full page" className="flex">
      <Button asChild variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground">
        <a href={fullHref} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} aria-label="Open full proof page">
          <Icon name="ExternalLink" className="size-4" aria-hidden />
        </a>
      </Button>
    </span> : null}
  </>;

  // One unified overlay shell (zero Vaul gesture conflict with iframe pan/pinch/swipe):
  // - Mobile: native-styled bottom sheet (92dvh, rounded top, grab bar, Done button) that expands to 100dvh on lightbox.
  // - Desktop: right-side overlay drawer with draggable left edge, borderless top utility strip, expanding to full window on lightbox.
  return <div
    className={`fixed inset-0 z-50 flex ${compact ? "flex-col justify-end" : "justify-end"} ${lightboxOpen ? "bg-black" : "bg-black/45 backdrop-blur-[1px]"} ${resizing ? "cursor-col-resize select-none" : ""}`}
    onClick={() => { if (!lightboxOpen) closeOverlay(); }}
  >
    <aside
      aria-label={`Proof: ${label}`}
      style={!compact && !lightboxOpen && panelWidth ? { width: `min(94vw, ${panelWidth}px)` } : undefined}
      className={`relative flex flex-col overflow-hidden bg-background ${
        lightboxOpen
          ? "h-dvh w-screen max-w-none rounded-none border-0 bg-black"
          : compact
            ? "h-[92dvh] w-full rounded-t-2xl border-t border-border/60 pb-[env(safe-area-inset-bottom)] shadow-2xl"
            : `h-full ${panelWidth ? "" : "w-[min(92vw,68rem)]"} border-l border-border/50 shadow-2xl`
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      {!compact && !lightboxOpen ? <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize proof panel"
        title="Drag to resize (double-click to reset)"
        onPointerDown={startResize}
        onDoubleClick={resetWidth}
        className="group absolute inset-y-0 -left-1.5 z-20 flex w-3 cursor-col-resize items-center justify-center"
      >
        <span className={`h-full w-0.5 transition-colors ${resizing ? "bg-primary/70" : "bg-transparent group-hover:bg-primary/45"}`} />
      </div> : null}
      {!lightboxOpen ? (compact ? <>
        <div className="flex justify-center pt-2.5 pb-1"><span aria-hidden className="h-1 w-10 rounded-full bg-muted-foreground/30" /></div>
        <div className="flex h-10 shrink-0 items-center gap-1.5 ps-4 pe-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
            <span data-bb-demo-sensitive>{unit ? unit.title : task.title}</span>
          </span>
          {actionControls}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-sm text-muted-foreground" onClick={closeOverlay}>Done</Button>
        </div>
      </> : <div className="flex h-10 shrink-0 items-center justify-end gap-1 px-2.5">
        {actionControls}
        <span title="Close proof panel" className="flex">
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" aria-label="Close proof panel" onClick={closeOverlay}>
            <Icon name="X" className="size-4" aria-hidden />
          </Button>
        </span>
      </div>) : null}
      <iframe ref={iframeRef} title={`Proof: ${label}`} src={embedUrl} className={`min-h-0 w-full flex-1 border-0 bg-background ${resizing ? "pointer-events-none" : ""}`} />
    </aside>
  </div>;
}

function NeedsYouSection({ tasks, projectName, chats, onOpenProof, onApproveProof, onResolveProposal }: {
  tasks: Task[];
  projectName: (task: Task) => string | undefined;
  chats: ChatPopupController;
  onOpenProof: (task: Task, unitId?: string) => void;
  onApproveProof: (task: Task, unitId?: string) => void;
  onResolveProposal: (task: Task, accept: boolean) => void;
}) {
  if (!tasks.length) return null;
  return <section aria-label="Needs you">
    <SectionHeader title="Needs you" count={tasks.length} />
    <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
      {tasks.map((task) => {
        const waitingUnit = task.run?.units?.find((unit) => unit.status === "waiting") ?? null;
        const activeProofId = waitingUnit?.proofPageId ?? task.run?.proofPageId;
        const hasProof = Boolean(proofEmbedUrl(activeProofId));
        const proposed = task.run?.proposedStatus === "done" && task.status !== "done" ? "done" : null;
        const awaitingProofApproval = (waitingUnit ? true : task.run?.phase === "waiting") && hasProof && task.threadIds.length > 0;
        const openChat = chats.opener(task);
        const project = projectName(task);
        const age = task.run?.updatedAt ? formatRunAge(task.run.updatedAt) : "";
        const meta = [project, age].filter(Boolean).join(" · ");
        const summary = waitingUnit?.summary || task.run?.summary || (waitingUnit ? `${waitingUnit.title} is ready for approval.` : awaitingProofApproval ? "Proof ready for your approval." : proposed ? "Live and ready to mark done." : task.run?.phase === "blocked" ? "Blocked — needs your input." : "Waiting for your decision.");
        const isBlocked = task.run?.phase === "blocked";
        const borderTone = isBlocked ? "border-destructive/40" : awaitingProofApproval ? "border-warning/40" : proposed ? "border-blue-500/40" : "border-warning/40";
        return <article key={task.id} data-needs-you={task.id} className={`flex flex-col justify-between gap-3 rounded-lg border bg-card p-3.5 ${borderTone}`}>
          <div className="space-y-1">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 text-sm font-medium leading-5 text-foreground">
                <span data-bb-demo-sensitive>{task.title}</span>
                {waitingUnit ? <span className="font-normal text-muted-foreground"> · <span data-bb-demo-sensitive>{waitingUnit.title}</span></span> : null}
              </span>
              {meta ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground"><span data-bb-demo-sensitive>{meta}</span></span> : null}
            </div>
            <p className="m-0 text-xs leading-5 text-muted-foreground">{summary}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {awaitingProofApproval ? <>
              <Button size="sm" onClick={() => onOpenProof(task, waitingUnit?.id)}>View proof</Button>
              <Button variant="outline" size="sm" onClick={() => onApproveProof(task, waitingUnit?.id)}>{waitingUnit ? "Approve unit" : "Approve & merge"}</Button>
            </> : proposed ? <>
              <Button size="sm" onClick={() => onResolveProposal(task, true)}>Mark {statusLabels[proposed]}</Button>
              <Button variant="outline" size="sm" onClick={() => onResolveProposal(task, false)}>Keep {statusLabels[task.status]}</Button>
              {hasProof ? <Button variant="outline" size="sm" onClick={() => onOpenProof(task)}>View proof</Button> : null}
            </> : hasProof ? <Button size="sm" onClick={() => onOpenProof(task, waitingUnit?.id)}>View proof</Button> : null}
            {openChat ? <Button variant={hasProof || proposed ? "outline" : "default"} size="sm" onClick={openChat}>{hasProof || proposed ? "Open chat" : "Answer in chat"}</Button> : null}
          </div>
        </article>;
      })}
    </div>
  </section>;
}

function TaskRow({ task, project, chat, onOpen, onRename, onStage, onResolveProposal, onOpenProof, onApproveProof, handle, active, children }: {
  task: Task; project?: string; chat: ChatState | null; onOpen?: () => void; onRename: (title: string) => void;
  onStage: (status: Task["status"]) => void; onResolveProposal: (accept: boolean) => void;
  onOpenProof: (task: Task, unitId?: string) => void; onApproveProof: (task: Task, unitId?: string) => void;
  handle: RowHandle; active: boolean; children: ReactNode;
}) {
  const units = task.run?.units ?? null;
  const hasActiveUnit = Boolean(units?.some((unit) => unit.status === "active" || unit.status === "waiting"));
  const [unitsToggled, setUnitsToggled] = useState<boolean | null>(null);
  const unitsOpen = unitsToggled ?? hasActiveUnit;
  if (isDraft(task)) return <li aria-busy className="flex min-w-0 items-center gap-3 py-1.5 pe-2 ps-3 opacity-50">
    <StatusGlyph status={task.status} />
    <span className="min-w-0 flex-1 truncate py-1 text-sm leading-5"><span data-bb-demo-sensitive>{task.title}</span></span>
  </li>;
  return <li {...handle} data-flip={task.id} style={chatTint(chat)} className={`flex flex-col ${draggable}`}>
    <div className={`group flex min-w-0 items-center gap-2.5 py-1.5 pe-2 ps-2 hover:bg-state-hover ${active ? "bg-state-hover" : ""}`}>
      <StatusPicker task={task} onStage={onStage} onResolveProposal={onResolveProposal} />
      <TaskTitle data-bb-demo-label title={task.title} onRename={onRename} onOpen={onOpen} className="min-w-0 flex-1 py-1 text-sm leading-5" clamp="block truncate" />
      <RunInlineBadge task={task} onOpenProof={onOpenProof} unitsOpen={unitsOpen} onToggleUnits={units?.length ? () => setUnitsToggled(!unitsOpen) : undefined} />
      {project ? <span className="hidden max-w-40 shrink-0 truncate text-xs text-subtle-foreground sm:block"><span data-bb-demo-sensitive>{project}</span></span> : null}
      <div data-no-drag="" className="flex shrink-0 items-center">{children}</div>
    </div>
    {units?.length && unitsOpen ? <TaskUnitsList task={task} units={units} onOpenProof={onOpenProof} onApproveProof={onApproveProof} /> : null}
  </li>;
}

// The recessed place a dragged task will drop into. It is one row tall.
function DropSlotRow() {
  return <li aria-hidden data-flip="slot" className="px-1.5 py-1"><div className="h-8 rounded-md bg-muted/60 shadow-[inset_0_1px_3px_rgb(0_0_0/0.45)]" /></li>;
}

function SectionHeader({ title, count, open, onToggle, highlight, children }: {
  title: string; count?: number; open?: boolean; onToggle?: () => void; highlight?: boolean; children?: ReactNode;
}) {
  const label = <>{title}{count === undefined ? null : <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span>}</>;
  return <div className="flex h-8 items-center justify-between gap-3">
    {onToggle
      ? <button type="button" aria-expanded={open} className={`-mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm font-medium outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring ${highlight ? "bg-state-hover ring-1 ring-ring" : ""}`} onClick={onToggle}>{label}<Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 text-muted-foreground" aria-hidden /></button>
      : <h2 className="flex items-center gap-2 text-sm font-medium">{label}</h2>}
    {children}
  </div>;
}

function useStoredToggle(key: string, initial = false) {
  const [open, setOpen] = useState(() => { const saved = localStorage.getItem(key); return saved === null ? initial : saved === "1"; });
  const set = (next: boolean) => { localStorage.setItem(key, next ? "1" : "0"); setOpen(next); };
  return [open, () => set(!open), set] as const;
}

// Ids kept in this browser, such as the project cards the user folded.
function useStoredSet(key: string) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set(savedBoard<string>(key) ?? []));
  const toggle = (id: string) => setIds((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    save(key, [...next]);
    return next;
  });
  return [ids, toggle] as const;
}

const listCard = "overflow-hidden rounded-md border border-border bg-surface-recessed/70 divide-y divide-border/60";

type Destination = { id: string; label: string; detail: string | null; projectId: string | null; provider: Provider };
let destinations: Destination[] | null = null;
let destinationsLoading: Promise<Destination[]> | null = null;
function loadDestinations(rpc: TasksRpc) {
  return destinationsLoading ??= rpc.call("createTaskOptions")
    .then((result) => destinations = result.providers.flatMap((entry) => entry.destinations.map((destination) => ({ ...destination, provider: entry.provider }))))
    .finally(() => { destinationsLoading = null; });
}

// A project offers the sources mapped to it. Akiflow's Inbox works for every project:
// the task is created there and then placed in the project.
function destinationsFor(all: Destination[], projectId: string) {
  const mapped = all.filter((destination) => destination.projectId === projectId);
  const inbox = all.find((destination) => destination.id === "akiflow:inbox");
  return inbox && !mapped.includes(inbox) ? [...mapped, inbox] : mapped;
}

const lastProjectKey = "task-workspaces:new-task-project";
const lastDestinationKey = (projectId: string) => `task-workspaces:new-task-in:${projectId}`;

type NewTaskPriority = "urgent" | "high";

// With a thread, the new task links that chat. With priority urgent, it starts in Now.
function NewTaskForm({ projects, initialProjectId, initialTitle = "", thread, priority, onDone }: {
  projects: ReadonlyArray<{ id: string; name: string }>; initialProjectId: string | null; initialTitle?: string;
  thread?: { id: string; title: string }; priority?: NewTaskPriority; onDone: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [all, setAll] = useState(destinations);
  const [failure, setFailure] = useState<string | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [projectId, setProjectId] = useState(() => {
    const last = localStorage.getItem(lastProjectKey);
    return initialProjectId ?? (projects.some((project) => project.id === last) ? last! : projects[0]?.id ?? "");
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const options = all && projectId ? destinationsFor(all, projectId) : [];
  const destination = options.find((option) => option.id === (chosen ?? localStorage.getItem(lastDestinationKey(projectId)))) ?? options[0];
  useEffect(() => {
    let live = true;
    loadDestinations(rpc).then(
      (next) => { if (live) setAll(next); },
      (error) => { if (live) setFailure(error instanceof Error ? error.message : String(error)); },
    );
    return () => { live = false; };
  }, [rpc]);
  const submit = () => {
    if (!title.trim() || !destination) return;
    localStorage.setItem(lastProjectKey, projectId);
    localStorage.setItem(lastDestinationKey(projectId), destination.id);
    createBoardTask(rpc, projectId, destination.id, title.trim(), thread?.id, priority);
    onDone();
  };
  return <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <DialogHeader>
      <DialogTitle>{priority === "urgent" ? "New task in Now" : "New task"}</DialogTitle>
      {thread
        ? <DialogDescription className="flex min-w-0 items-center gap-1.5"><Icon name="MessageSquare" className="size-3.5 shrink-0" aria-hidden /><span className="sr-only">Links the chat</span><span className="truncate"><span data-bb-demo-sensitive>{thread.title}</span></span></DialogDescription>
        : <DialogDescription className="sr-only">Name the task, then choose its project and where it is created.</DialogDescription>}
    </DialogHeader>
    <Input data-bb-demo-sensitive autoFocus aria-label="Task title" placeholder="Task title" value={title} onChange={(event) => setTitle(event.target.value)} />
    <div className="grid gap-2 sm:grid-cols-2">
      <Select value={projectId} onValueChange={(next) => { if (projects.some((project) => project.id === next)) { setProjectId(next); setChosen(null); } }}>
        <SelectTrigger data-bb-demo-sensitive aria-label="Project"><SelectValue placeholder="Project" /></SelectTrigger>
        <SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id}><span data-bb-demo-sensitive>{project.name}</span></SelectItem>)}</SelectContent>
      </Select>
      <Select value={destination?.id ?? ""} onValueChange={(next) => { if (options.some((option) => option.id === next)) setChosen(next); }} disabled={!options.length}>
        <SelectTrigger data-bb-demo-sensitive aria-label="Create in"><SelectValue placeholder={failure ?? (all ? "No task source for this project" : "Loading sources…")} /></SelectTrigger>
        <SelectContent>{options.map((option) => <SelectItem key={option.id} value={option.id}>
          <span className="flex min-w-0 items-center gap-2"><ProviderIcon provider={option.provider} /><span className="truncate"><span data-bb-demo-sensitive>{option.id === "akiflow:inbox" ? "Akiflow Inbox" : option.label}</span></span></span>
        </SelectItem>)}</SelectContent>
      </Select>
    </div>
    <DialogFooter><Button type="button" variant="outline" onClick={onDone}>Cancel</Button><Button type="submit" disabled={!title.trim() || !destination}>Create task</Button></DialogFooter>
  </form>;
}

function NewTaskButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <span title="New task" className="flex">
    <Button aria-label={label} variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={onClick}><Icon name="Plus" className="size-4" aria-hidden /></Button>
  </span>;
}

type ProjectColumn = ReturnType<typeof organizeTasks>["columns"][number];
const columnPreview = 5;
const isLabelled = (column: ProjectColumn) => column.groups.length > 1 || column.groups[0]?.priority !== "none";

// Masonry deals cards by height before they render, so it estimates each card in px from what
// it shows. A title wraps to at most two lines.
function cardHeight(column: ProjectColumn, expanded: boolean, folded: boolean, charsPerLine: number) {
  const header = 41;
  const gap = 12;
  if (!column.tasks.length || folded) return header + gap;
  let budget = expanded ? Infinity : columnPreview;
  let height = header + gap + 12 + (column.tasks.length > columnPreview ? 33 : 0);
  for (const group of column.groups) {
    const shown = group.tasks.slice(0, budget);
    budget -= shown.length;
    if (!shown.length) continue;
    height += 8 + (isLabelled(column) ? 26 : 0);
    for (const task of shown) height += 12 + 20 * Math.min(2, Math.ceil(task.title.length / charsPerLine));
  }
  return height;
}

// The content width of an element. The first width is read before paint, so the layout does not jump.
function useWidth() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const style = getComputedStyle(node);
    setWidth(node.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    observer.current = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
    observer.current.observe(node);
  }, []);
  return [width, ref] as const;
}

// Clicking the header folds a card into a single bar with its count, like a project without tasks.
// A card that takes drops gets `dropRef`. It lights up while a task from another project is over it.
function ProjectCard({ column, expanded, onExpand, folded, onFold, onRename, onStage, onResolveProposal, onOpenProof, onCreate, onMenu, menuOpen, actions, handle, draggingId, landing, menuId, dropRef, over }: {
  column: ProjectColumn; expanded: boolean; onExpand: () => void; folded: boolean; onFold: () => void;
  onRename: (task: Task, title: string) => void;
  onStage: (task: Task, status: Task["status"]) => void;
  onResolveProposal: (task: Task, accept: boolean) => void;
  onOpenProof: (task: Task) => void;
  onCreate?: () => void;
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void; menuOpen: boolean;
  actions: (task: Task) => ReactNode; handle: (task: Task) => RowHandle; draggingId: string | null; landing: boolean; menuId?: string;
  dropRef?: (element: HTMLElement | null) => void; over: boolean;
}) {
  let budget = expanded ? Infinity : columnPreview;
  const labelled = isLabelled(column);
  const empty = !column.tasks.length;
  const open = !empty && !folded;
  const name = <span className="min-w-0 flex-1 truncate"><span data-bb-demo-sensitive={column.id ? "" : undefined}>{column.name}</span></span>;
  return <section data-bb-demo-label ref={dropRef} aria-label={column.name} className={`overflow-hidden rounded-md border border-border bg-surface-recessed/70 ${over ? "ring-1 ring-ring" : ""}`}>
    <h3 onContextMenu={onMenu} className={`flex min-h-10 items-center text-sm font-medium ${draggable} ${open ? "border-b border-border" : "text-muted-foreground"} ${onCreate ? "pe-1.5" : ""} ${menuOpen || over ? "bg-state-hover" : empty ? "" : "hover:bg-state-hover"}`}>
      {empty
        ? <span className={`flex min-w-0 flex-1 ps-3 ${onCreate ? "pe-2" : "pe-3"}`}><span data-bb-demo-sensitive>{name}</span></span>
        : <button type="button" aria-expanded={open} className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 self-stretch ps-3 text-left outline-none focus-visible:bg-state-hover ${onCreate ? "pe-2" : "pe-3"}`} onClick={onFold}>
          <span data-bb-demo-sensitive>{name}</span><span className="text-xs font-normal tabular-nums text-muted-foreground">{column.tasks.length}</span>
        </button>}
      {onCreate ? <NewTaskButton label={`New task in ${column.name}`} onClick={onCreate} /> : null}
    </h3>
    {!open ? null : <div className="space-y-2 p-1.5">
      {column.groups.map((group) => {
        const shown = group.tasks.slice(0, budget);
        budget -= shown.length;
        return shown.length ? <div key={group.priority}>
          {labelled ? <h4 className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{priorityLabels[group.priority]}<span className="font-normal tabular-nums text-subtle-foreground">{group.tasks.length}</span></h4> : null}
          <ul>{shown.map((task) => isDraft(task)
            ? <li key={task.id} aria-busy className="flex items-start gap-2 px-2 py-1.5 opacity-50">
              <span className="mt-0.5"><StatusGlyph status={task.status} /></span>
              <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-5"><span data-bb-demo-sensitive>{task.title}</span></span>
            </li>
            : <li key={task.id} {...handle(task)} data-task={task.id} className={`group flex items-start gap-1.5 rounded-md px-1.5 py-1.5 transition-opacity hover:bg-state-hover ${draggable} ${task.id === draggingId ? landing ? "opacity-0" : "opacity-40" : ""} ${task.id === menuId ? "bg-state-hover" : ""}`}>
              <StatusPicker task={task} onStage={(status) => onStage(task, status)} onResolveProposal={(accept) => onResolveProposal(task, accept)} />
              <TaskTitle data-bb-demo-label title={task.title} onRename={(title) => onRename(task, title)} className="min-w-0 flex-1 text-sm leading-5" clamp="line-clamp-2" />
              <span className="mt-0.5 flex items-center"><RunInlineBadge task={task} onOpenProof={onOpenProof} /></span>
              <span data-no-drag="" className="-my-1 flex">{actions(task)}</span>
            </li>)}</ul>
        </div> : null;
      })}
    </div>}
    {open && column.tasks.length > columnPreview ? <button type="button" aria-expanded={expanded} className="w-full border-t border-border px-3.5 py-2 text-left text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover" onClick={onExpand}>{expanded ? "Show less" : `Show all ${column.tasks.length}`}</button> : null}
  </section>;
}

const threadPreview = 5;
const threadTitle = (thread: SidebarThread) => thread.displayTitle || "Untitled thread";

// Open chats that no task links. Each one either joins a task or should not be running.
function UnassignedThreads({ threads, projectNames, chats, open, onToggle, onAssign }: {
  threads: SidebarThread[]; projectNames: ReadonlyMap<string, string>; chats: ChatPopupController;
  open: boolean; onToggle: () => void; onAssign: (thread: SidebarThread) => void;
}) {
  const [all, setAll] = useState(false);
  return <section aria-label="Unassigned threads">
    <SectionHeader title="Unassigned threads" count={threads.length} open={open} onToggle={onToggle} />
    {open ? <ul className={`mt-2 ${listCard}`}>
      {(all ? threads : threads.slice(0, threadPreview)).map((thread) => <li key={thread.id} style={chatTint(chats.stateOf(thread.id))} className="flex min-w-0 items-center gap-3 py-1.5 pe-2 ps-3 hover:bg-state-hover">
        <span className="flex size-4 shrink-0 items-center justify-center text-subtle-foreground"><Icon name="MessageSquare" className="size-3.5" aria-hidden /></span>
        <button type="button" className="min-w-0 flex-1 truncate py-1 text-left text-sm leading-5 outline-none focus-visible:underline" onClick={() => chats.peek(thread.id, threadTitle(thread), () => onAssign(thread))}><span data-bb-demo-sensitive>{threadTitle(thread)}</span></button>
        {projectNames.get(thread.projectId) ? <span className="hidden max-w-40 shrink-0 truncate text-xs text-subtle-foreground sm:block"><span data-bb-demo-sensitive>{projectNames.get(thread.projectId)}</span></span> : null}
        <span title="Add to task" className="flex">
          <Button data-bb-demo-label aria-label={`Add to task: ${threadTitle(thread)}`} variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => onAssign(thread)}><Icon name="TaskAdd" className="size-4" aria-hidden /></Button>
        </span>
      </li>)}
      {threads.length > threadPreview ? <li><button type="button" aria-expanded={all} className="w-full px-4 py-2 text-left text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${threads.length}`}</button></li> : null}
    </ul> : null}
  </section>;
}

// Picks the task a chat joins. New task comes first. Then come tasks in the chat's project,
// and within each group Now, Later and the rest. Arrow keys move between rows.
function TaskPicker({ thread, tasks, projectNames, onPick, onCreate }: {
  thread: SidebarThread; tasks: Task[]; projectNames: ReadonlyMap<string, string>;
  onPick: (task: Task) => void; onCreate: (title: string) => void;
}) {
  const compact = useIsCompactViewport();
  const [query, setQuery] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const projectOf = (task: Task) => task.effectiveProjectId ?? task.projectId ?? "";
  const ranked = useMemo(() => {
    const rank = (task: Task) => (projectOf(task) === thread.projectId ? 0 : 3) + (taskPriority(task) === "urgent" ? 0 : taskPriority(task) === "high" ? 1 : 2);
    return [...tasks].sort((left, right) => rank(left) - rank(right) || byPosition(left, right));
  }, [tasks, thread.projectId]);
  const words = query.trim().toLowerCase();
  const shown = words ? ranked.filter((task) => `${task.title} ${task.identifier} ${projectNames.get(projectOf(task)) ?? ""}`.toLowerCase().includes(words)) : ranked;
  const step = (event: ReactKeyboardEvent, from: Element | null) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll("button") ?? []);
    const index = rows.findIndex((button) => button === from);
    const next = rows[event.key === "ArrowDown" ? index + 1 : index - 1];
    event.preventDefault();
    if (next) next.focus();
    else if (event.key === "ArrowUp") (event.currentTarget.closest("[role=dialog]")?.querySelector("input") as HTMLInputElement | null)?.focus();
  };
  const row = "flex w-full min-w-0 select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none hover:bg-state-hover focus-visible:bg-state-hover";
  return <>
    <label className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-4">
      <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <input data-bb-demo-sensitive aria-label="Search tasks" placeholder="Search tasks" autoFocus={!compact} value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => step(event, null)}
        className={`min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground ${COARSE_POINTER_TEXT_BASE_CLASS}`} />
    </label>
    <ul ref={list} aria-label="Tasks" className="min-h-0 flex-1 overflow-y-auto p-1.5" onKeyDown={(event) => step(event, document.activeElement)}>
      <li><button type="button" className={row} onClick={() => onCreate(query.trim() || threadTitle(thread))}>
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"><Icon name="Plus" className="size-3.5" aria-hidden /></span>
        <span className="min-w-0 flex-1 truncate">{words ? <>New task <span className="text-muted-foreground">“<span data-bb-demo-sensitive>{query.trim()}</span>”</span></> : "New task"}</span>
      </button></li>
      {shown.slice(0, 100).map((task) => <li key={task.id}><button type="button" className={row} onClick={() => onPick(task)}>
        <StatusGlyph status={task.status} />
        <span className="min-w-0 flex-1 truncate"><span data-bb-demo-sensitive>{task.title}</span></span>
        <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground"><span data-bb-demo-sensitive>{projectNames.get(projectOf(task))}</span></span>
      </button></li>)}
      {words && !shown.length ? <li className="px-2.5 py-2 text-sm text-muted-foreground">No matching tasks.</li> : null}
    </ul>
  </>;
}

type ProviderHealth = {
  provider: Provider;
  enabled: boolean;
  status: "ok" | "disabled" | "unconfigured" | "stale" | "error";
  lastError: string | null;
  lastOkAt: string | null;
};
const healthColor: Record<ProviderHealth["status"], string> = {
  ok: "var(--success)",
  disabled: "var(--muted-foreground)",
  unconfigured: "var(--warning-text)",
  stale: "var(--warning-text)",
  error: "var(--destructive-text)",
};
function healthLabel(entry: ProviderHealth) {
  if (entry.status === "unconfigured") return "not configured";
  if (entry.status === "stale") return "credentials expired or invalid";
  if (entry.status === "error") return entry.lastError ?? "last sync failed";
  return entry.lastOkAt ? `last synced ${new Date(entry.lastOkAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : "not synced yet";
}

/** Source icons keep sync details on hover and available to screen readers. */
function ProviderHealthFooter() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const load = useCallback(() => { void rpc.call("providerHealth").then(setHealth, () => undefined); }, [rpc]);
  useEffect(() => { if (connection === "connected") load(); }, [connection, load]);
  // Only a sync or a settings change can change health.
  useRealtime("tasks-changed", useCallback((payload: unknown) => {
    const reason = (payload as { reason?: string } | null)?.reason;
    if (connection === "connected" && (reason === "sync" || reason === "settings" || reason === "provider-setting")) load();
  }, [connection, load]));
  const shown = health.filter((entry) => entry.enabled);
  if (!shown.length) return null;
  return <footer aria-label="Source sync" className="shrink-0 border-t border-border-hairline">
    <div className="mx-auto flex h-8 w-full max-w-5xl items-center gap-3 px-4 text-xs">
      {shown.map((entry) => <span role="img" aria-label={`${providerLabels[entry.provider]}: ${healthLabel(entry)}`} key={entry.provider} className="flex shrink-0 items-center gap-1.5 text-muted-foreground" title={`${providerLabels[entry.provider]}: ${healthLabel(entry)}`}>
        <span aria-hidden className="size-1.5 rounded-full" style={{ background: healthColor[entry.status] }} />
        <ProviderIcon provider={entry.provider} />
      </span>)}
    </div>
  </footer>;
}

function TasksScreen() {
  const { rpc, tasks, loading: tasksLoading, mutate, rename, hiddenProjects, hideProject, linkedThreadIds } = useTasks(true);
  const { projects, threads, status: threadStatus } = useSidebarThreads();
  const [laterOpen, toggleLater, setLaterOpen] = useStoredToggle("task-workspaces:later-open");
  const [allOpen, toggleAll] = useStoredToggle("task-workspaces:all-open");
  const [unassignedOpen, toggleUnassigned] = useStoredToggle("task-workspaces:unassigned-open", true);
  const [hiddenOpen, toggleHidden] = useStoredToggle("task-workspaces:hidden-open");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const [folded, toggleFolded] = useStoredSet("task-workspaces:folded-projects:v1");
  const [width, measure] = useWidth();
  const [newTask, setNewTask] = useState({ open: false, projectId: null as string | null, priority: undefined as NewTaskPriority | undefined, key: 0 });
  const openNewTask = (projectId: string | null, priority?: NewTaskPriority) => setNewTask((current) => ({ open: true, projectId, priority, key: current.key + 1 }));
  const closeNewTask = () => setNewTask((current) => ({ ...current, open: false }));
  useEffect(() => { if (!destinations) void loadDestinations(rpc).catch(() => undefined); }, [rpc]);
  const [busy, setBusy] = useState<string | null>(null);
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const chats = useChatPopup(tasks, mutate);
  const { stateOf, taskState } = chats;
  // Chat states come live from the sidebar, so rows move and change color as their chats do.
  // The board waits for the first states, so rows do not jump when they arrive.
  const loading = tasksLoading || chats.loading;
  const { personal, now, later, columns } = useMemo(() => organizeTasks(loading ? [] : tasks, projectNames, taskState), [loading, tasks, projectNames, taskState]);
  const projectName = (task: Task) => projectNames.get(task.effectiveProjectId ?? task.projectId ?? "");
  // Top-level open chats that no task links, by state and then newest first. Chats on shown tasks
  // count as linked too, so a chat leaves this list the moment it joins a task.
  const unassigned = useMemo(() => {
    if (threadStatus !== "ready" || !linkedThreadIds) return [];
    const linked = new Set([...linkedThreadIds, ...tasks.flatMap((task) => task.threadIds)]);
    return byChatState(threads.filter((thread) => !thread.isArchived && !thread.isHidden && !thread.parentThreadId && !linked.has(thread.id))
      .sort((left, right) => right.updatedAt - left.updatedAt), (thread) => stateOf(thread.id));
  }, [threadStatus, linkedThreadIds, tasks, threads, stateOf]);
  const [assigning, setAssigning] = useState({ open: false, thread: null as SidebarThread | null, title: null as string | null, key: 0 });
  const closeAssigning = () => setAssigning((current) => ({ ...current, open: false }));
  // The chat shows on the task at once. A task's first chat also moves it to the chat's project.
  const assign = (thread: SidebarThread, task: Task) => {
    closeAssigning();
    mutate({ [task.id]: { threadIds: [thread.id, ...task.threadIds], ...(task.threadIds.length ? {} : { projectId: thread.projectId, effectiveProjectId: thread.projectId }) } },
      () => rpc.call("attachExistingChat", { taskId: task.id, threadId: thread.id }));
    toast("Chat added to task", { description: <span data-bb-demo-sensitive>{task.title}</span> });
  };
  // Hidden projects leave All tasks and wait in the Hidden section below it.
  const shownColumns = columns.filter((column) => !hiddenProjects.has(column.id));
  const hiddenColumns = columns.filter((column) => hiddenProjects.has(column.id));
  // All tasks is a masonry of project cards: 3 columns from 768px, 2 from 576px.
  const stackCount = width >= 768 ? 3 : width >= 576 ? 2 : 1;
  const charsPerLine = Math.max(12, ((width - 12 * (stackCount - 1)) / stackCount - 144) / 7);
  // A card keeps its column while the page is open, so a move or a fold does not reshuffle the board.
  const placed = useRef({ count: 0, columns: new Map<string, number>() });
  if (placed.current.count !== stackCount) placed.current = { count: stackCount, columns: new Map() };
  const stacks = (list: ProjectColumn[]) => {
    const dealt = masonry(list, stackCount, (column) => cardHeight(column, expanded.has(column.id), folded.has(column.id), charsPerLine),
      (column) => placed.current.columns.get(column.id));
    dealt.forEach((stack, index) => { for (const column of stack) placed.current.columns.set(column.id, index); });
    return dealt;
  };
  const moveStage = (task: Task, status: Task["status"]) => mutate({ [task.id]: { status } }, () => rpc.call("setStatus", { taskId: task.id, status }));
  // Now and Later are ordered lists. A move stores the order on screen, which sorts by chat state first.
  // The new order shows at once, and the server stores it.
  // Later also shows tasks with open chats that are not high. They keep their priority until moved.
  const arrange = (task: Task, { list, index }: DropSlot) => {
    const shown = list === "urgent" ? now : later;
    const own = new Set(shown.filter((item) => taskPriority(item) === list).map((item) => item.id));
    const taskIds = placeTask(shown.map((item) => item.id), task.id, index).filter((id) => id === task.id || own.has(id));
    const patch: Record<string, TaskPatch> = Object.fromEntries(taskIds.map((id, position) => [id, { position }]));
    if (taskPriority(task) !== list) patch[task.id] = { ...patch[task.id], refs: task.refs.map((ref) => ({ ...ref, priority: list })) };
    mutate(patch, () => rpc.call("arrangeTasks", { priority: list, taskIds }));
  };
  const [deleting, setDeleting] = useState<Task | null>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const deleteReturnFocus = useRef<HTMLElement | null>(null);
  const moves: TaskMoves = {
    // A task sent to Now goes last. A task sent to Later goes first, so it is next.
    priority: (task, priority) => {
      if (priority === "urgent") arrange(task, { list: "urgent", index: now.filter((item) => item.id !== task.id).length });
      else if (priority === "high") arrange(task, { list: "high", index: 0 });
      else {
        const value = priority === "none" ? null : priority;
        mutate({ [task.id]: { position: null, refs: task.refs.map((ref) => ({ ...ref, priority: value })) } }, () => rpc.call("setPriority", { taskId: task.id, priority: value }));
      }
    },
    // Done and Delete take the task off the screen, so both offer Undo.
    stage: (task, status) => {
      if (status === "cancelled") {
        const row = scroller.current?.querySelector(`[data-flip="${CSS.escape(task.id)}"], [data-task="${CSS.escape(task.id)}"]`);
        deleteReturnFocus.current = row?.querySelector<HTMLElement>('button[aria-label^="More actions:"]') ?? null;
        setDeleting(task);
        return;
      }
      moveStage(task, status);
      if (status === "done") toast("Task marked done", {
        description: <span data-bb-demo-sensitive>{task.title}</span>,
        action: { label: "Undo", onClick: () => moveStage(task, task.status) },
      });
    },
    project: (task, projectId) => mutate({ [task.id]: { projectId, effectiveProjectId: projectId } }, () => rpc.call("setProject", { taskId: task.id, projectId })),
  };
  const scroller = useRef<HTMLDivElement>(null);
  const dnd = useTaskDrag({
    lists: { urgent: now, high: later }, laterOpen, openLater: () => setLaterOpen(true), scroller, onDrop: arrange,
    projectOf: (task) => task.effectiveProjectId ?? task.projectId ?? "", onMove: moves.project,
  });
  const menu = (task: Task) => <TaskMenu task={task} projects={projects} moves={moves} />;
  const [contextMenu, setContextMenu] = useState<{ taskId?: string; projectId?: string; x: number; y: number } | null>(null);
  const contextTask = contextMenu && tasks.find((task) => task.id === contextMenu.taskId);
  const contextProject = contextMenu?.projectId === undefined ? undefined : columns.find((column) => column.id === contextMenu.projectId);
  // Portaled menus bubble React events to their row, so only events from inside the row count.
  const row = (task: Task): RowHandle => ({
    ...dnd.handle(task),
    onContextMenu: (event) => {
      if (dnd.draggingId || !event.currentTarget.contains(event.target as Node) || (event.target as Element).closest("textarea")) return;
      event.preventDefault();
      setContextMenu({ taskId: task.id, x: event.clientX, y: event.clientY });
    },
  });
  const printNow = async () => {
    setBusy("print");
    try { const result = await rpc.call("printNow"); toast.success(`Print job accepted for ${result.accepted} tasks`); }
    catch (error) { toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>); }
    finally { setBusy(null); }
  };
  const [proofTarget, setProofTarget] = useState<{ taskId: string; unitId?: string } | null>(null);
  const proofTask = proofTarget ? tasks.find((task) => task.id === proofTarget.taskId) ?? null : null;
  const proofUnit = proofTask && proofTarget?.unitId ? proofTask.run?.units?.find((unit) => unit.id === proofTarget.unitId) ?? null : null;
  const openProof = (task: Task, unitId?: string) => setProofTarget({ taskId: task.id, unitId });
  const resolveProposal = (task: Task, accept: boolean) => {
    const proposed = task.run?.proposedStatus;
    if (!proposed) return;
    mutate(
      accept ? { [task.id]: { status: proposed } } : {},
      () => rpc.call("resolveRunProposal", { taskId: task.id, accept }),
    );
    if (accept && proposed === "done") {
      if (proofTarget?.taskId === task.id) setProofTarget(null);
      toast("Task marked done", {
        description: <span data-bb-demo-sensitive>{task.title}</span>,
        action: { label: "Undo", onClick: () => moveStage(task, task.status) },
      });
    }
  };
  const approveProof = (task: Task, unitId?: string) => {
    if (proofTarget?.taskId === task.id) setProofTarget(null);
    mutate({}, () => rpc.call("approveTaskProof", { taskId: task.id, ...(unitId ? { unitId } : {}) }));
    toast.success(unitId ? "Unit approved — sent to chat" : "Approved — sent to chat", { description: <span data-bb-demo-sensitive>{task.title}</span> });
  };
  const promote = (task: Task) => <RowAction label="Move to Now" icon="ArrowUp" task={task} onClick={() => moves.priority(task, "urgent")} />;
  const cards = (list: ProjectColumn[]) => <div className="flex items-start gap-3">{stacks(list).map((stack, index) => <div key={index} className="flex min-w-0 flex-1 flex-col gap-3">
    {stack.map((column) => <ProjectCard key={column.id} column={column} expanded={expanded.has(column.id)} onExpand={() => toggleExpanded(column.id)}
      folded={folded.has(column.id)} onFold={() => toggleFolded(column.id)} onRename={rename}
      onStage={moves.stage} onResolveProposal={resolveProposal} onOpenProof={openProof}
      onCreate={column.id ? () => openNewTask(column.id) : undefined}
      onMenu={(event) => { event.preventDefault(); setContextMenu({ projectId: column.id, x: event.clientX, y: event.clientY }); }} menuOpen={contextMenu?.projectId === column.id}
      handle={row} draggingId={dnd.draggingId} landing={dnd.landing} menuId={contextMenu?.taskId}
      dropRef={projectNames.has(column.id) ? dnd.cardRef(column.id) : undefined} over={dnd.overProject === column.id}
      actions={(task) => <>{promote(task)}{menu(task)}</>} />)}
  </div>)}</div>;
  // During a drag the page ignores the pointer, so rows under the card do not light up.
  return <div className="flex h-full flex-col text-foreground"><div className="flex min-h-0 flex-1 overflow-hidden"><div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
    <div ref={measure} className={`mx-auto w-full max-w-5xl space-y-8 px-4 pb-12 pt-6 ${dnd.draggingId ? "pointer-events-none" : ""}`}>
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); cancelDelete.current?.focus(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); deleteReturnFocus.current?.focus(); }}>
          <DialogHeader><DialogTitle>Delete task?</DialogTitle><DialogDescription>Delete “<span data-bb-demo-sensitive>{deleting?.title}</span>”? This marks the task cancelled in its linked providers and archives attached work.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button ref={cancelDelete} variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => {
              if (deleting) {
                const task = deleting;
                moveStage(task, "cancelled");
                toast("Task deleted", { description: <span data-bb-demo-sensitive>{task.title}</span>, action: { label: "Undo", onClick: () => moveStage(task, task.status) } });
              }
              setDeleting(null);
            }}>Delete task</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <header className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-recessed/70"><PluginIcon name={tasksIcon} className="size-5" /></div>
        <div className="min-w-0"><h1 className="text-base font-semibold leading-5">Tasks</h1><p className="text-xs leading-4 text-muted-foreground">Plan work across your task sources.</p></div>
      </header>
      <NeedsYouSection tasks={personal.filter((task) => !isDraft(task) && needsAttention(task))} projectName={projectName} chats={chats} onOpenProof={openProof} onApproveProof={approveProof} onResolveProposal={resolveProposal} />
      <section ref={dnd.zoneRef.urgent} aria-label="Now">
        <SectionHeader title="Now" count={loading ? undefined : now.length}>
          <div className="flex items-center">
            <span title="Print Now"><Button aria-label="Print Now" variant="ghost" size="icon" className="size-7 text-muted-foreground" disabled={!now.length || busy !== null} onClick={() => void printNow()}><Icon name="Printer" className="size-4" aria-hidden /></Button></span>
            <NewTaskButton label="New task in Now" onClick={() => openNewTask(null, "urgent")} />
          </div>
        </SectionHeader>
        <ul ref={dnd.listRef.urgent} className={`relative mt-2 ${listCard}`}>
          {dnd.items("urgent", now).map((task) => task ? <TaskRow key={task.id} task={task} project={projectName(task)} chat={taskState(task)} onOpen={chats.opener(task)} onRename={(title) => rename(task, title)} onStage={(status) => moves.stage(task, status)} onResolveProposal={(accept) => resolveProposal(task, accept)} onOpenProof={openProof} onApproveProof={approveProof} handle={row(task)} active={task.id === contextMenu?.taskId || task.id === proofTarget?.taskId}>
            <RowAction label="Move to Later" icon="Clock" task={task} onClick={() => moves.priority(task, "high")} />
            <ChatMenu task={task} chats={chats} />
            {menu(task)}
          </TaskRow> : <DropSlotRow key="slot" />)}
          {!dnd.items("urgent", now).length ? <li className="px-4 py-3 text-sm text-muted-foreground">{loading ? "Loading tasks…" : "Nothing in Now. Drag a task here, or move one up from Later or All tasks."}</li> : null}
        </ul>
      </section>
      <section ref={dnd.zoneRef.high} aria-label="Later">
        <SectionHeader title="Later" count={loading ? undefined : later.length} open={laterOpen} onToggle={toggleLater} highlight={dnd.overLaterHeader} />
        {laterOpen ? <ul ref={dnd.listRef.high} className={`relative mt-2 ${listCard}`}>
          {dnd.items("high", later).map((task) => task ? <TaskRow key={task.id} task={task} project={projectName(task)} chat={taskState(task)} onOpen={chats.opener(task)} onRename={(title) => rename(task, title)} onStage={(status) => moves.stage(task, status)} onResolveProposal={(accept) => resolveProposal(task, accept)} onOpenProof={openProof} onApproveProof={approveProof} handle={row(task)} active={task.id === contextMenu?.taskId || task.id === proofTarget?.taskId}>{promote(task)}<ChatMenu task={task} chats={chats} />{menu(task)}</TaskRow> : <DropSlotRow key="slot" />)}
          {!dnd.items("high", later).length ? <li className="px-4 py-3 text-sm text-muted-foreground">{loading ? "Loading tasks…" : "Nothing in Later."}</li> : null}
        </ul> : null}
      </section>
      {unassigned.length ? <UnassignedThreads threads={unassigned} projectNames={projectNames} chats={chats} open={unassignedOpen} onToggle={toggleUnassigned}
        onAssign={(thread) => setAssigning((current) => ({ open: true, thread, title: null, key: current.key + 1 }))} /> : null}
      <section aria-label="All tasks">
        <SectionHeader title="All tasks" count={loading ? undefined : shownColumns.reduce((count, column) => count + column.tasks.length, 0)} open={allOpen} onToggle={toggleAll}>
          <NewTaskButton label="New task" onClick={() => openNewTask(null)} />
        </SectionHeader>
        {allOpen ? <div className="mt-2">
          {shownColumns.length && !loading
            ? cards(shownColumns)
            : <p className={`${listCard} px-4 py-3 text-sm text-muted-foreground`}>{loading ? "Loading tasks…" : "No open tasks."}</p>}
        </div> : null}
      </section>
      {hiddenColumns.length && !loading ? <section aria-label="Hidden">
        <SectionHeader title="Hidden" count={hiddenColumns.length} open={hiddenOpen} onToggle={toggleHidden} />
        {hiddenOpen ? <div className="mt-2">{cards(hiddenColumns)}</div> : null}
      </section> : null}
    </div>
    {chats.popup}
    {contextMenu && contextTask ? <PointMenu key={`${contextMenu.x},${contextMenu.y}`} at={contextMenu} onClose={() => setContextMenu(null)}>
      <TaskMenuContent task={contextTask} projects={projects} moves={moves} align="start" />
    </PointMenu> : null}
    {contextMenu && contextProject ? <PointMenu key={`${contextMenu.x},${contextMenu.y}`} at={contextMenu} onClose={() => setContextMenu(null)}>
      <DropdownMenuContent data-bb-demo-label align="start" mobileTitle={contextProject.name} className="min-w-36">
        {hiddenProjects.has(contextProject.id)
          ? <DropdownMenuItem onSelect={() => hideProject(contextProject.id, false)}><Icon name="Eye" className="size-3.5" aria-hidden />Show project</DropdownMenuItem>
          : <DropdownMenuItem onSelect={() => hideProject(contextProject.id, true)}><Icon name="EyeOff" className="size-3.5" aria-hidden />Hide project</DropdownMenuItem>}
      </DropdownMenuContent>
    </PointMenu> : null}
    <Dialog open={newTask.open} onOpenChange={(open) => { if (!open) closeNewTask(); }}>
      <DialogContent>
        <NewTaskForm key={newTask.key} projects={projects} initialProjectId={newTask.projectId} priority={newTask.priority} onDone={closeNewTask} />
      </DialogContent>
    </Dialog>
    <Dialog open={assigning.open} onOpenChange={(open) => { if (!open) closeAssigning(); }}>
      {assigning.thread && assigning.title !== null
        ? <DialogContent>
          <NewTaskForm key={assigning.key} projects={projects} initialProjectId={projectNames.has(assigning.thread.projectId) ? assigning.thread.projectId : null}
            initialTitle={assigning.title} thread={{ id: assigning.thread.id, title: threadTitle(assigning.thread) }} onDone={closeAssigning} />
        </DialogContent>
        : assigning.thread ? <DialogContent style={{ width: "min(96vw, 30rem)" }} className="flex h-[min(70vh,34rem)] max-w-none flex-col gap-0 overflow-hidden p-0">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border pe-12 ps-4">
            <DialogTitle className="shrink-0 text-sm font-medium leading-normal">Add to task</DialogTitle>
            <DialogDescription className="min-w-0 flex-1 truncate text-sm text-muted-foreground"><span data-bb-demo-sensitive>{threadTitle(assigning.thread)}</span></DialogDescription>
            <Button variant="ghost" size="sm" className="shrink-0 md:hidden" onClick={closeAssigning}>Done</Button>
          </div>
          <TaskPicker key={assigning.key} thread={assigning.thread} tasks={personal.filter((task) => !isDraft(task))} projectNames={projectNames}
            onPick={(task) => assign(assigning.thread!, task)} onCreate={(title) => setAssigning((current) => ({ ...current, title }))} />
        </DialogContent> : null}
    </Dialog>
  </div>{proofTask ? <ProofSidePanel task={proofTask} unit={proofUnit} onClose={() => setProofTarget(null)} onApproveProof={approveProof} onResolveProposal={resolveProposal} /> : null}</div><ProviderHealthFooter /></div>;
}

function NowHomeCard({ projectId }: { projectId: string | null }) {
  const { tasks, loading, mutate, rename } = useTasks();
  const navigate = useBbNavigate();
  const chats = useChatPopup(tasks, mutate);
  const now = byChatState(tasks.filter((task) => isOpenPersonalTask(task) && taskPriority(task) === "urgent"
    && (!projectId || (task.effectiveProjectId ?? task.projectId) === projectId)).sort(byPosition), chats.taskState);
  return <section aria-label="Now tasks" className="text-foreground">
    <div className="-mt-9 mb-2 flex justify-end"><span title="Open tasks"><Button aria-label="Open tasks" variant="ghost" size="icon" className="size-7" onClick={() => navigate.toPluginPanel("tasks")}><PluginIcon name={tasksIcon} className="size-3.5" /></Button></span></div>
    {loading || chats.loading ? null : now.length ? <ul className="space-y-0.5">{now.map((task) => <li key={task.id} style={chatTint(chats.taskState(task))} className="flex items-center gap-1 rounded-md pe-0.5 hover:bg-state-hover">
      <TaskTitle data-bb-demo-label title={task.title} onRename={(title) => rename(task, title)} onOpen={chats.opener(task)} className="min-w-0 flex-1 px-2 py-1.5 text-sm leading-5" clamp="block truncate" />
      <ChatMenu task={task} chats={chats} />
    </li>)}</ul> : <p className="px-2 text-xs text-muted-foreground">Nothing in Now.</p>}
    {chats.popup}
  </section>;
}

function OpenTaskCount() {
  const { tasks } = useTasks();
  const count = tasks.filter((task) => isOpenPersonalTask(task) && taskPriority(task) === "urgent").length;
  if (!count) return null;
  return <span data-task-sidebar-count="" aria-label={`${count} tasks in Now`} className="text-xs tabular-nums text-muted-foreground">{count}</span>;
}

function useNeedsAttentionBadge() {
  const { tasks } = useTasks();
  const attention = tasks.filter((task) => !isDraft(task) && isOpenPersonalTask(task) && needsAttention(task));
  if (!attention.length) return null;
  const hasBlocked = attention.some((task) => task.run?.phase === "blocked");
  return {
    count: attention.length,
    tone: hasBlocked ? ("critical" as const) : ("warning" as const),
    label: attention.length === 1 ? "1 task needs you" : `${attention.length} tasks need you`,
  };
}

export default definePluginApp((app) => {
  for (const action of taskCommandPaletteActions()) app.slots.commandPaletteAction(action);
  app.slots.homepageSection({ id: "now", title: "Now", component: NowHomeCard });
  app.slots.navPanel({
    id: "tasks",
    title: "Tasks",
    icon: tasksIcon,
    path: "tasks",
    component: () => <div data-bb-demo-ready className="contents"><TasksScreen /></div>,
    experimental_sidebarAccessory: OpenTaskCount,
    ...(typeof process !== "undefined" && process.env?.VITEST ? {} : { experimental_useBadge: useNeedsAttentionBadge } as Record<string, unknown>),
  });
  app.slots.settingsSection({ id: "preferences", component: SettingsPanel });
  app.slots.settingsSection({ id: "more", component: MoreSettings });
  app.slots.experimental_threadHeaderAction({ id: "task", title: "Attached task", component: ThreadTaskChip });
  app.slots.pendingInteraction({ id: "finish-task", component: FinishTaskInteraction });
  app.slots.experimental_appOverlay({ id: "archived-task", component: ArchivedTaskPrompt });
});
