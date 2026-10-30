import { Component, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer, experimental_ProviderIcon as ProviderIcon, experimental_useSidebarThreads as useSidebarThreads,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu, experimental_THREAD_ACTION_GROUPS as THREAD_ACTION_GROUPS,
  ThreadChat, ThreadTitle, useBbNavigate, useRpc, useSdk, useSidebarThreadDraftIds, type NewThreadRequest, type PluginThreadActionsInlineItem,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { chatOrder, type ChatState, type Task } from "./task-layout.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Icon } from "@/components/ui/icon";

export type SidebarThread = ReturnType<typeof useSidebarThreads>["threads"][number];
type ChatTask = Pick<Task, "id" | "identifier" | "title" | "threadIds" | "refs" | "projectId" | "effectiveProjectId">;

// The popup shows up to three chats side by side. A task with more asks which ones first.
const maxColumns = 3;

const busyStatuses = new Set(["starting", "active", "stopping"]);
const workingIndicators = new Set(["runtime", "workflow", "background-agent", "background-command", "working-draft", "plan-mode", "goal"]);
// The sidebar's chat states and colors.
const chatStates: Record<ChatState, { label: string; color: string | null }> = {
  input: { label: "Needs input", color: "var(--warning-text)" },
  unread: { label: "Unread", color: "var(--success)" },
  draft: { label: "Draft", color: "color-mix(in oklab, var(--warning-text) 62%, var(--destructive-text))" },
  working: { label: "Working", color: "var(--timeline-accent)" },
  idle: { label: "Idle", color: null },
};

// A chat that needs input counts first. A working chat counts as working even when it is unread.
function chatState(thread: SidebarThread | undefined, draft: boolean): ChatState {
  if (!thread) return "idle";
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input" || thread.indicator === "unread-error") return "input";
  const { workflows, backgroundAgents, backgroundCommands, planMode, goals } = thread.activity;
  if (busyStatuses.has(thread.status) || workingIndicators.has(thread.indicator)
    || workflows + backgroundAgents + backgroundCommands + planMode + goals > 0) return "working";
  if (draft) return "draft";
  return thread.isUnread ? "unread" : "idle";
}

// A row takes the color of its most urgent chat. An idle chat gives it a faint gray.
// A row without an open chat stays plain. The wash intentionally has no left-edge rail.
export function chatTint(state: ChatState | null): CSSProperties | undefined {
  if (!state) return undefined;
  const color = chatStates[state].color ?? "color-mix(in oklab, var(--subtle-foreground) 50%, transparent)";
  const wash = `color-mix(in oklab, ${color} 9%, transparent)`;
  return { backgroundImage: `linear-gradient(${wash}, ${wash})` };
}

export function ChatDot({ state, className = "size-1.5" }: { state: ChatState; className?: string }) {
  const { label, color } = chatStates[state];
  return <span role="img" aria-label={label} title={label} style={color ? { background: color } : undefined}
    className={`shrink-0 rounded-full ${className} ${color ? "" : "bg-subtle-foreground/50"} ${state === "working" ? "animate-pulse" : ""}`} />;
}

function ChatName({ threadId, thread }: { threadId: string; thread: SidebarThread | undefined }) {
  return thread ? <span data-bb-demo-sensitive><ThreadTitle threadId={threadId} /></span> : <>Chat</>;
}

function IconButton({ label, icon, onClick, disabled }: { label: string; icon: "ChevronLeft" | "ExternalLink" | "MessageSquarePlus" | "Paperclip" | "TaskAdd"; onClick: () => void; disabled?: boolean }) {
  return <span title={label} className="flex">
    <Button aria-label={label} variant="ghost" size="icon" disabled={disabled} className="size-7 text-muted-foreground" onClick={onClick}>
      <Icon name={icon} className="size-4" aria-hidden />
    </Button>
  </span>;
}

export function ChatHeaderMenu({ threadId, thread, onOpen, onUnattach, children }: {
  threadId?: string;
  thread: SidebarThread | undefined;
  onOpen?: () => void;
  onUnattach?: () => void;
  children: ReactElement;
}) {
  if (!threadId || !thread || !onOpen) return children;
  const inline: PluginThreadActionsInlineItem[] = [{
    key: "task-workspaces/open-chat",
    group: THREAD_ACTION_GROUPS.open,
    action: { label: "Open chat", icon: "ExternalLink", run: onOpen },
  }];
  if (onUnattach) inline.push({
    key: "task-workspaces/detach",
    group: THREAD_ACTION_GROUPS.organize,
    action: { label: "Detach from task", icon: "Unlink", run: onUnattach },
  });
  return <ThreadActionsContextMenu
    thread={{
      ...thread,
      environment: thread.environment?.id
        ? { id: thread.environment.id, path: thread.environment.path }
        : null,
    }}
    inline={inline}
  >{children}</ThreadActionsContextMenu>;
}

class ChatErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p role="alert" className="p-4 text-sm text-muted-foreground">This chat could not be shown. Open it in the thread view instead.</p>
      : this.props.children;
  }
}

// A pane takes the place of the chats. "attach" lists open threads to attach, and "new" is the
// new-chat composer. Opened from a row's menu, the pane is the whole popup. Opened from the
// popup, Back returns to `chatIds`. A chat that no task links has no taskId and no panes.
// Its popup can offer `assign` to add it to a task.
type ChatView = { taskId: string | null; title: string; chatIds: string[] | null; pane?: "attach" | "new"; from?: "menu" | "popup"; seed?: NewChatSeed; assign?: () => void };
type NewChatSeed = { projectId?: string; prompt: string };
type AttachPatch = (patch: Record<string, Pick<Task, "threadIds">>, call: () => Promise<unknown>) => void;

// A new chat starts in the task's project. Its message names the task and links the task's
// GitHub or Linear page, which holds the details.
function newChatSeed(task: ChatTask): NewChatSeed {
  const links = task.refs.filter((ref) => (ref.provider === "github" || ref.provider === "linear") && ref.url).map((ref) => ref.url);
  return { projectId: task.effectiveProjectId ?? task.projectId ?? undefined, prompt: [`Work on ${task.identifier}: ${task.title}`, ...links].join("\n") };
}

/** Opens a task's chats in a popup instead of leaving the page. */
export function useChatPopup(tasks: readonly Task[], mutate: AttachPatch) {
  const rpc = useRpc<typeof rpcContract>();
  const { status, threads, projects } = useSidebarThreads();
  const drafts = useSidebarThreadDraftIds();
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  // A task's open chats, newest first. Until the live list loads, every linked chat counts.
  const openChats = useCallback((task: Pick<Task, "threadIds">) => status === "ready"
    ? task.threadIds.filter((id) => byId.get(id)?.isArchived === false)
    : task.threadIds, [status, byId]);
  const stateOf = useCallback((threadId: string) => chatState(byId.get(threadId), drafts.has(threadId)), [byId, drafts]);
  // A task takes the state of its most urgent open chat. A task without one has no state.
  const taskState = useCallback((task: Pick<Task, "threadIds">) => {
    const states = openChats(task).map(stateOf);
    return chatOrder.find((state) => states.includes(state)) ?? null;
  }, [openChats, stateOf]);
  const [view, setView] = useState<ChatView | null>(null);
  // Without chosen chats, the popup shows every open chat, or asks when there are more than three.
  // A task whose chats are all archived shows its newest one.
  const show = useCallback((task: ChatTask, chatIds?: string[]) => {
    const open = openChats(task);
    const ids = chatIds ?? (open.length ? open : task.threadIds.slice(0, 1));
    setView({ taskId: task.id, title: task.title, chatIds: !chatIds && ids.length > maxColumns ? null : ids });
  }, [openChats]);
  // A title opens its task's chats. A task without an open chat has nothing to open.
  const opener = useCallback((task: ChatTask) => openChats(task).length ? () => show(task) : undefined, [openChats, show]);
  const attach = useCallback((task: ChatTask) => setView({ taskId: task.id, title: task.title, chatIds: [], pane: "attach", from: "menu" }), []);
  const compose = useCallback((task: ChatTask) => setView({ taskId: task.id, title: task.title, chatIds: [], pane: "new", from: "menu", seed: newChatSeed(task) }), []);
  const peek = useCallback((threadId: string, title: string, assign?: () => void) => setView({ taskId: null, title, chatIds: [threadId], assign }), []);
  // The chat leaves the task at once and waits under Unassigned threads. The server also keeps
  // it from joining the task again by itself. Undo attaches it again.
  const detach = useCallback((task: ChatTask, threadId: string) => {
    mutate({ [task.id]: { threadIds: task.threadIds.filter((id) => id !== threadId) } }, () => rpc.call("detachTaskThread", { threadId, taskId: task.id }));
    toast("Thread detached", { description: <span data-bb-demo-sensitive>{task.title}</span>, action: { label: "Undo", onClick: () =>
      mutate({ [task.id]: { threadIds: task.threadIds } }, () => rpc.call("attachExistingChat", { taskId: task.id, threadId })) } });
  }, [mutate, rpc]);
  const task = view && tasks.find((item) => item.id === view.taskId);
  // The chat shows on the task at once. The server links it and moves the task to doing.
  const attachThread = (threadId: string) => {
    if (!view || !task) return;
    mutate({ [task.id]: { threadIds: [threadId, ...task.threadIds] } }, () => rpc.call("attachExistingChat", { taskId: task.id, threadId }));
    if (view.from === "menu") setView(null);
    else setView({ ...view, pane: undefined, chatIds: view.chatIds && [threadId, ...view.chatIds].slice(0, maxColumns) });
  };
  // The composer chose where the chat runs. When this throws, the composer keeps the draft.
  const startChat = async (request: NewThreadRequest) => {
    const taskId = view?.taskId;
    if (!taskId) return;
    try {
      const { threadId } = await rpc.call("startTaskThread", { taskId, request });
      const linked = tasks.find((item) => item.id === taskId)?.threadIds ?? [];
      mutate({ [taskId]: { threadIds: [threadId, ...linked.filter((id) => id !== threadId)] } }, async () => undefined);
      setView((current) => current?.taskId === taskId
        ? { ...current, pane: undefined, seed: undefined, chatIds: [threadId, ...(current.chatIds ?? [])].slice(0, maxColumns) }
        : current);
    } catch (error) {
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : String(error)}</span>);
      throw error;
    }
  };
  const openPane = (pane: ChatView["pane"]) => view && setView({
    ...view, pane, from: pane ? view.pane ? view.from : "popup" : undefined,
    seed: pane === "new" ? view.seed ?? (task ? newChatSeed(task) : { prompt: "" }) : view.seed,
  });
  const popup = view ? <ChatPopup key={view.taskId ?? view.chatIds?.[0]} view={view} available={task ? openChats(task) : view.chatIds ?? []} byId={byId} stateOf={stateOf}
    pane={view.pane === "attach" ? <ThreadPicker status={status} threads={threads} projects={projects} attached={task?.threadIds ?? []} stateOf={stateOf} onPick={attachThread} />
      : view.pane === "new" && view.seed && view.taskId ? <NewChat taskId={view.taskId} seed={view.seed} onSubmit={startChat} /> : null}
    onShow={(chatIds) => setView({ ...view, chatIds })}
    onPane={openPane}
    onUnattach={task ? (threadId) => {
      detach(task, threadId);
      const remaining = view.chatIds?.filter((id) => id !== threadId);
      setView(remaining?.length ? { ...view, chatIds: remaining } : null);
    } : undefined}
    onClose={() => setView(null)} /> : null;
  return { show, opener, attach, compose, detach, peek, openChats, byId, stateOf, taskState, popup, loading: status === "loading" };
}

export type ChatPopupController = ReturnType<typeof useChatPopup>;

function ChatPopup({ view, available, byId, stateOf, pane, onShow, onPane, onUnattach, onClose }: {
  view: ChatView; available: string[]; byId: ReadonlyMap<string, SidebarThread>; stateOf: (threadId: string) => ChatState; pane: ReactNode;
  onShow: (chatIds: string[] | null) => void; onPane: (pane: ChatView["pane"]) => void; onUnattach?: (threadId: string) => void; onClose: () => void;
}) {
  const navigate = useBbNavigate();
  const compact = useIsCompactViewport();
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<string | null>(null);
  const columns = view.chatIds;
  const openFull = (threadId: string) => { onClose(); navigate.toThread(threadId); };
  const toggle = (threadId: string) => setSelected((current) => current.includes(threadId) ? current.filter((id) => id !== threadId) : [...current, threadId]);
  // A plain click opens one chat. Shift-click selects it, like the checkbox.
  const pick = (event: ReactMouseEvent, threadId: string) => {
    if (event.shiftKey) toggle(threadId);
    else onShow([threadId]);
  };
  const width = view.pane === "new" ? "min(96vw, 40rem)" : columns && !pane ? `min(96vw, ${Math.max(columns.length, 1) * 39}rem)` : "min(96vw, 30rem)";
  const height = view.pane === "new" ? "max-h-[85dvh]" : pane ? (compact ? "h-[85dvh]" : "h-[min(70vh,34rem)]") : columns ? (compact ? "h-[85dvh]" : "h-[min(88vh,60rem)]") : "";
  const shown = columns && (columns.find((id) => id === tab) ?? columns[0]);
  // A popup with one chat has one bar. It holds the chat's state, its machine and the link to the thread view.
  // A chat without a task always opens alone.
  const single = !pane && columns?.length === 1 ? columns[0]! : null;
  const singleName = single ? byId.get(single)?.displayTitle : undefined;
  const bare = !view.taskId;
  const back = view.pane ? view.from === "popup" ? <IconButton label="Back" icon="ChevronLeft" onClick={() => onPane(undefined)} /> : null
    : columns && available.length > maxColumns ? <IconButton label="All chats" icon="ChevronLeft" onClick={() => onShow(null)} /> : null;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent style={compact ? undefined : { width }}
      className={`flex max-w-none flex-col gap-0 overflow-hidden p-0 ${compact ? "pb-[env(safe-area-inset-bottom)]" : ""} ${height}`}>
      <ChatHeaderMenu threadId={single ?? undefined} thread={single ? byId.get(single) : undefined} onOpen={single ? () => openFull(single) : undefined} onUnattach={single && onUnattach ? () => onUnattach(single) : undefined}>
      <div className={`flex h-12 shrink-0 items-center gap-1 border-b border-border ps-2 ${compact ? "pe-2" : "pe-12"}`}>
        {back ?? <span className="w-2" />}
        {single ? <ChatDot state={stateOf(single)} className="ms-1 me-1.5 size-1.5" /> : null}
        <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium leading-normal">
          <span data-bb-demo-sensitive>{view.title}</span>{singleName && singleName !== view.title ? <span className="font-normal text-muted-foreground"> · <span data-bb-demo-sensitive>{singleName}</span></span> : null}
        </DialogTitle>
        <DialogDescription className="sr-only">{bare ? "A chat that no task links." : view.pane === "attach" ? "Attach an open thread to this task." : view.pane === "new" ? "Start a chat on this task." : "Chats attached to this task."}</DialogDescription>
        {single ? machineOf(byId.get(single)) : null}
        {bare ? view.assign ? <IconButton label="Add to task" icon="TaskAdd" onClick={() => { onClose(); view.assign?.(); }} /> : null : <>
          {view.pane === "attach" ? null : <IconButton label="Attach thread" icon="Paperclip" onClick={() => onPane("attach")} />}
          {view.pane === "new" ? null : <IconButton label="New chat" icon="MessageSquarePlus" onClick={() => onPane("new")} />}
        </>}
        {compact ? <Button variant="ghost" size="sm" onClick={onClose}>Done</Button> : null}
      </div>
      </ChatHeaderMenu>
      {pane ?? (!columns ? <>
        <ul aria-label="Chats" className="max-h-[60vh] overflow-y-auto p-1.5">{available.map((id) => <li key={id} className={`flex items-center gap-1 rounded-md ps-2.5 hover:bg-state-hover ${selected.includes(id) ? "bg-state-active" : ""}`}>
          <Checkbox aria-label="Select chat" checked={selected.includes(id)} onCheckedChange={() => toggle(id)} />
          <button type="button" className="flex min-w-0 flex-1 select-none items-center gap-2.5 rounded-sm py-2 pe-2.5 ps-1.5 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={(event) => pick(event, id)}>
            <span className="min-w-0 flex-1 truncate"><ChatName threadId={id} thread={byId.get(id)} /></span>
            <ChatDot state={stateOf(id)} />
          </button>
        </li>)}</ul>
        <div className="flex items-center gap-3 border-t border-border py-2.5 pe-2.5 ps-4">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{selected.length ? `${selected.length} selected` : compact ? "Tap to open. Tick to choose several." : "Click to open. Shift-click to choose several."}</p>
          <Button size="sm" disabled={!selected.length} onClick={() => onShow(available.filter((id) => selected.includes(id)))}>Open{selected.length > 1 ? ` ${selected.length}` : ""}</Button>
        </div>
      </> : compact ? <>
        {columns.length > 1 && shown ? <ChatHeaderMenu threadId={shown} thread={byId.get(shown)} onOpen={() => openFull(shown)} onUnattach={onUnattach ? () => onUnattach(shown) : undefined}><div className="flex shrink-0 items-center gap-1 border-b border-border py-1.5 pe-1.5 ps-2">
          <div role="tablist" aria-label="Chats" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {columns.map((id) => <button key={id} type="button" role="tab" aria-selected={id === shown}
              className={`flex max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs outline-none ${id === shown ? "bg-state-active text-foreground" : "text-muted-foreground"}`}
              onClick={() => setTab(id)}><ChatDot state={stateOf(id)} /><span className="truncate"><ChatName threadId={id} thread={byId.get(id)} /></span></button>)}
          </div>
          <span data-bb-demo-sensitive>{machineOf(byId.get(shown))}</span>
        </div></ChatHeaderMenu> : null}
        {shown ? <ChatColumn key={shown} threadId={shown} thread={byId.get(shown)} state={stateOf(shown)} /> : null}
      </> : <div className="grid min-h-0 flex-1 auto-cols-[minmax(22rem,1fr)] grid-flow-col divide-x divide-border overflow-x-auto">
        {columns.map((id) => <ChatColumn key={id} threadId={id} thread={byId.get(id)} state={stateOf(id)} onOpenFull={single ? undefined : () => openFull(id)} onUnattach={onUnattach ? () => onUnattach(id) : undefined} />)}
      </div>)}
    </DialogContent>
  </Dialog>;
}

// Without onOpenFull, the column has no header, because the popup's bar or tabs name the chat.
function ChatColumn({ threadId, thread, state, onOpenFull, onUnattach }: { threadId: string; thread: SidebarThread | undefined; state: ChatState; onOpenFull?: () => void; onUnattach?: () => void }) {
  return <section data-bb-demo-label aria-label={thread?.displayTitle ?? "Chat"} className="flex min-h-0 min-w-0 flex-1 flex-col">
    {onOpenFull ? <ChatHeaderMenu threadId={threadId} thread={thread} onOpen={onOpenFull} onUnattach={onUnattach}><div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pe-3.5 ps-3.5">
      <ChatDot state={state} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground"><ChatName threadId={threadId} thread={thread} /></span>
      <span data-bb-demo-sensitive>{machineOf(thread)}</span>
    </div></ChatHeaderMenu> : null}
    <div className="min-h-0 flex-1">
      <ChatErrorBoundary><ThreadChat threadId={threadId} variant="compact" layout="contained" /></ChatErrorBoundary>
    </div>
  </section>;
}

type Sdk = ReturnType<typeof useSdk>;
type Host = Awaited<ReturnType<Sdk["hosts"]["experimental_resume"]>>;
type MachineProvider = Awaited<ReturnType<Sdk["hosts"]["experimental_listProviders"]>>[number];

// BB's thread view shows a paused sandbox above its composer. ThreadChat leaves that bar out,
// so the bar that names the chat shows the same state and Resume button for its machine.
const machineOf = (thread: SidebarThread | undefined) => thread?.host
  ? <MachineStatus key={thread.host.id} hostId={thread.host.id} runtime={thread.runtimeStatus} /> : null;

function MachineStatus({ hostId, runtime }: { hostId: string; runtime: SidebarThread["runtimeStatus"] }) {
  const sdk = useSdk();
  const [host, setHost] = useState<Host | null>(null);
  const [provider, setProvider] = useState<MachineProvider | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => sdk.hosts.get({ hostId }).then(setHost, () => undefined), [sdk, hostId]);
  // The thread's runtime moves when its machine wakes or sleeps, so it also triggers a fresh read.
  useEffect(() => {
    void load();
    return sdk.subscribe({ event: "host:changed", hostId, callback: () => void load() });
  }, [sdk, hostId, load, runtime]);
  const phase = host?.machineProviderId ? host.lifecycle.phase : null;
  // Pausing and resuming finish without a host event until the machine connects or drops.
  useEffect(() => {
    if (phase !== "suspending" && phase !== "resuming") return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [phase, load]);
  const providerId = host?.machineProviderId;
  useEffect(() => {
    if (!providerId) return;
    void sdk.hosts.experimental_listProviders().then((providers) => setProvider(providers.find((item) => item.id === providerId) ?? null), () => undefined);
  }, [sdk, providerId]);
  if (!host || (phase !== "suspended" && phase !== "suspending" && phase !== "resuming")) return null;
  const resume = async () => {
    setFailed(false);
    setHost((current) => current && { ...current, lifecycle: { ...current.lifecycle, phase: "resuming" } });
    try {
      setHost(await sdk.hosts.experimental_resume({ hostId }));
    } catch (error) {
      setFailed(true);
      toast.error(<span data-bb-demo-sensitive>{error instanceof Error ? error.message : "Could not resume the machine."}</span>);
      void load();
    }
  };
  return <span role="status" aria-label="Machine status" className="flex shrink-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
    <ProviderIcon providerKind="machine" provider={provider ?? { id: host.machineProviderId ?? "machine" }} fallback="Server" className="size-3.5 shrink-0" aria-hidden />
    <span className="whitespace-nowrap">{phase === "resuming" ? "Resuming…" : phase === "suspending" ? "Pausing…" : "Machine paused"}</span>
    {phase === "suspended" ? <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => void resume()}>{failed ? "Retry" : "Resume"}</Button> : null}
  </span>;
}

type Sidebar = ReturnType<typeof useSidebarThreads>;

// BB's own new-thread composer, so the chat's project, model, host, sandbox and worktree are
// chosen here. The draft is kept per task until it is sent.
function NewChat({ taskId, seed, onSubmit }: { taskId: string; seed: NewChatSeed; onSubmit: (request: NewThreadRequest) => Promise<void> }) {
  const compact = useIsCompactViewport();
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">
    <NewThreadComposer defaultProjectId={seed.projectId} initialPrompt={seed.prompt} draftKey={`task-workspaces:new-chat:${taskId}`}
      layout="document" placeholder="What should the agent do?" focusRequest={compact ? undefined : 1} onSubmit={onSubmit} />
  </div>;
}

// Every open thread can join the task, newest first. The search matches titles and projects.
function ThreadPicker({ status, threads, projects, attached, stateOf, onPick }: Pick<Sidebar, "status" | "threads" | "projects"> & {
  attached: string[]; stateOf: (threadId: string) => ChatState; onPick: (threadId: string) => void;
}) {
  const compact = useIsCompactViewport();
  const [query, setQuery] = useState("");
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  // Only top-level threads can join a task.
  const open = useMemo(() => threads.filter((thread) => !thread.isArchived && !thread.isHidden && !thread.parentThreadId && !attached.includes(thread.id))
    .sort((a, b) => b.updatedAt - a.updatedAt), [threads, attached]);
  const words = query.trim().toLowerCase();
  const shown = (words ? open.filter((thread) => `${thread.displayTitle} ${names.get(thread.projectId) ?? ""}`.toLowerCase().includes(words)) : open).slice(0, 100);
  return <>
    <label className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-4">
      <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <input data-bb-demo-sensitive aria-label="Search open threads" placeholder="Search open threads" autoFocus={!compact} value={query} onChange={(event) => setQuery(event.target.value)}
        className={`min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground ${COARSE_POINTER_TEXT_BASE_CLASS}`} />
    </label>
    {shown.length ? <ul aria-label="Open threads" className="min-h-0 flex-1 overflow-y-auto p-1.5">{shown.map((thread) => <li key={thread.id}>
      <button type="button" className="flex w-full min-w-0 select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none hover:bg-state-hover focus-visible:bg-state-hover" onClick={() => onPick(thread.id)}>
        <ChatDot state={stateOf(thread.id)} />
        <span className="min-w-0 flex-1 truncate"><span data-bb-demo-sensitive>{thread.displayTitle || "Untitled thread"}</span></span>
        <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground"><span data-bb-demo-sensitive>{names.get(thread.projectId)}</span></span>
      </button>
    </li>)}</ul> : <p className="flex-1 px-4 py-3 text-sm text-muted-foreground">{status !== "ready" ? "Loading threads…" : words ? "No matching threads." : "No open threads."}</p>}
  </>;
}

// The chat bubble from the icon set. It holds a plus when the task has no open chat,
// and the number of open chats when it has some.
const bubble = "M21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C10.3719 21.5 8.8394 21.0904 7.5 20.3687C5.63177 19.362 4.37462 20.2979 3.26592 20.4658C3.09774 20.4913 2.93024 20.4302 2.80997 20.31C2.62741 20.1274 2.59266 19.8451 2.6935 19.6074C3.12865 18.5818 3.5282 16.6382 2.98341 15C2.6698 14.057 2.5 13.0483 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5C17.2467 2.5 21.5 6.75329 21.5 12Z";

function ChatGlyph({ count }: { count: number }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={bubble} />
    {count ? <text x="12" y="12.5" textAnchor="middle" dominantBaseline="central" fill="currentColor" stroke="none" fontSize={count > 9 ? 9 : 11} fontWeight="600">{count > 9 ? "9+" : count}</text>
      : <path d="M15.5 12H8.5M12 8.5V15.5" />}
  </svg>;
}

/**
 * A task's chat button. A mouse hover opens its menu, and a tap opens it as a sheet.
 * A click opens the task's chats, or the menu when it has none.
 */
export function ChatMenu({ task, chats }: { task: ChatTask; chats: ChatPopupController }) {
  const compact = useIsCompactViewport();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef("mouse");
  const ids = chats.openChats(task);
  const state = chats.taskState(task);
  const label = (!ids.length ? "Add chat" : ids.length === 1 ? "1 chat" : `${ids.length} chats`) + (!state || state === "idle" ? "" : `, ${chatStates[state].label.toLowerCase()}`);
  // A pick opens the popup over the menu, so the menu goes at once, without its fade.
  // A fading menu can stay behind the popup, and it takes focus back from it.
  const [picked, setPicked] = useState(false);
  const toggle = (next: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    if (next) setPicked(false);
    setOpen(next);
  };
  const choose = (action: () => void) => () => { setPicked(true); action(); };
  const later = (next: boolean, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => toggle(next), delay);
  };
  const hover = (next: boolean, delay: number) => (event: { pointerType: string }) => { if (event.pointerType === "mouse") later(next, delay); };
  const chatItem = (id: string, onSelect: () => void) => <DropdownMenuItem key={id} onSelect={onSelect}>
    <span className="flex size-4 shrink-0 items-center justify-center"><ChatDot state={chats.stateOf(id)} /></span>
    <span className="min-w-0 flex-1 truncate"><ChatName threadId={id} thread={chats.byId.get(id)} /></span>
  </DropdownMenuItem>;
  return <span title={label} className="flex"><DropdownMenu open={open} onOpenChange={toggle} modal={false}>
    <DropdownMenuTrigger asChild>
      <Button data-bb-demo-label aria-label={`${label}: ${task.title}`} variant="ghost" size="icon" className="size-7 text-muted-foreground"
        onPointerEnter={hover(true, 120)} onPointerLeave={hover(false, 160)}
        // With a mouse, the hover opens the menu, so a press must not toggle it shut.
        onPointerDown={(event) => { pointer.current = event.pointerType; if (event.pointerType === "mouse") event.preventDefault(); }}
        onClick={() => {
          if (pointer.current !== "mouse") return;
          if (!ids.length) toggle(true);
          else choose(() => { toggle(false); chats.show(task); })();
        }}>
        <ChatGlyph count={ids.length} />
      </Button>
    </DropdownMenuTrigger>
    {picked ? null : <DropdownMenuContent data-bb-demo-label align="end" mobileTitle={task.title} className="w-64" onPointerEnter={hover(true, 0)} onPointerLeave={hover(false, 160)}>
      {ids.map((id) => chatItem(id, choose(() => chats.show(task, [id]))))}
      {ids.length ? <DropdownMenuSeparator /> : null}
      {ids.length > 1 ? <DropdownMenuItem onSelect={choose(() => chats.show(task))}><Icon name="Layers" className="size-3.5" aria-hidden />{ids.length > maxColumns ? "Choose chats" : compact ? "Open all" : "Open side by side"}</DropdownMenuItem> : null}
      <DropdownMenuItem onSelect={choose(() => chats.compose(task))}><Icon name="MessageSquarePlus" className="size-3.5" aria-hidden />New chat</DropdownMenuItem>
      <DropdownMenuItem onSelect={choose(() => chats.attach(task))}><Icon name="Paperclip" className="size-3.5" aria-hidden />Attach thread</DropdownMenuItem>
      {ids.length === 1 ? <DropdownMenuItem onSelect={() => chats.detach(task, ids[0]!)}><Icon name="Unlink" className="size-3.5" aria-hidden />Detach thread</DropdownMenuItem>
        // The phone sheet has no submenus, so its chats list under a label.
        : ids.length > 1 && compact ? <><DropdownMenuSeparator /><DropdownMenuLabel>Detach thread</DropdownMenuLabel>{ids.map((id) => chatItem(id, () => chats.detach(task, id)))}</>
        : ids.length > 1 ? <DropdownMenuSub>
          <DropdownMenuSubTrigger><Icon name="Unlink" className="size-3.5" aria-hidden />Detach thread</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">{ids.map((id) => chatItem(id, () => chats.detach(task, id)))}</DropdownMenuSubContent>
        </DropdownMenuSub> : null}
    </DropdownMenuContent>}
  </DropdownMenu></span>;
}
