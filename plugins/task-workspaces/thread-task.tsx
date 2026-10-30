import { Fragment, useCallback, useEffect, useState } from "react";
import { experimental_Icon as PluginIcon, useBbNavigate, useRealtime, useRpc, type PluginThreadHeaderActionProps, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import type { rpcContract } from "./server";
import { statusLabels } from "./task-layout.js";

type ThreadTaskState = PluginRpcResult<(typeof rpcContract)["threadTask"]>;
type ThreadTask = ThreadTaskState["attachedTasks"][number];

const providerNames: Record<string, string> = { akiflow: "Akiflow", linear: "Linear", github: "GitHub" };
const HEADER_BUTTON_CLASS = "size-7 text-muted-foreground hover:text-foreground";

function TaskSummary({ task }: { task: ThreadTask }) {
  return <DropdownMenuLabel className="max-w-72 space-y-0.5">
    <div data-bb-demo-label className="truncate text-sm font-medium text-foreground" title={task.title}><span data-bb-demo-sensitive>{task.title}</span></div>
    <div className="truncate font-normal"><span data-bb-demo-sensitive>{task.identifier}</span> · {statusLabels[task.status]}</div>
  </DropdownMenuLabel>;
}

// One icon in every viewport. The identifiers and titles live in the menu.
export function ThreadTaskChip({ threadId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<ThreadTaskState | null>(null);
  const load = useCallback(async () => {
    try { setState(await rpc.call("threadTask", { threadId })); }
    catch { setState(null); }
  }, [rpc, threadId]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("tasks-changed", load);
  const attached = state?.attachedTasks ?? [];
  if (attached.length) {
    const identifiers = attached.map((task) => task.identifier).join(", ");
    return <DropdownMenu>
      <span data-bb-demo-label title={identifiers}><DropdownMenuTrigger asChild>
        <Button data-bb-demo-label aria-label={`Attached tasks: ${identifiers}`} className={HEADER_BUTTON_CLASS} size="icon" variant="ghost">
          <PluginIcon className="size-3.5" name="task-workspaces/tasks" aria-hidden />
        </Button>
      </DropdownMenuTrigger></span>
      <DropdownMenuContent align="end" mobileTitle={attached.length === 1 ? "Attached task" : "Attached tasks"} className="min-w-56">
        {attached.map((task, index) => {
          const link = task.refs.find((ref) => ref.url);
          return <Fragment key={task.id}>
            {index ? <DropdownMenuSeparator /> : null}
            <TaskSummary task={task} />
            {link?.url ? <DropdownMenuItem onSelect={() => navigate.openUrl(link.url!)}>
              <Icon className="size-3.5" name="ExternalLink" aria-hidden />Open in {providerNames[link.provider] ?? link.provider}
            </DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={() => void rpc.call("detachTaskThread", { threadId, taskId: task.id })}>
              <Icon className="size-3.5" name="Unlink" aria-hidden />Detach from chat
            </DropdownMenuItem>
          </Fragment>;
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate.toPluginPanel("tasks")}>
          <PluginIcon className="size-3.5" name="task-workspaces/tasks" aria-hidden />Open Tasks
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>;
  }
  const suggestion = state?.suggested;
  if (!suggestion) return null;
  return <DropdownMenu>
    <span data-bb-demo-label title={`Suggested: ${suggestion.title}`}><DropdownMenuTrigger asChild>
      <Button data-bb-demo-label aria-label={`Suggested task: ${suggestion.identifier}`} className={HEADER_BUTTON_CLASS} size="icon" variant="ghost">
        <Icon className="size-3.5" name="TaskAdd" aria-hidden />
      </Button>
    </DropdownMenuTrigger></span>
    <DropdownMenuContent align="end" mobileTitle="Suggested task" className="min-w-56">
      <TaskSummary task={suggestion} />
      <DropdownMenuItem onSelect={() => void rpc.call("attachExistingChat", { taskId: suggestion.id, threadId })}>
        <Icon className="size-3.5" name="Paperclip" aria-hidden />Attach to this chat
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void rpc.call("declineThreadTask", { threadId, taskId: suggestion.id })}>
        <Icon className="size-3.5" name="X" aria-hidden />Not this task
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
