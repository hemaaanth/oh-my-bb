import { useEffect, useState } from "react";
import { useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";

type Candidate = {
  source: "task-workspaces";
  id: string;
  identifier: string;
  title: string;
  status: string;
  attachedThreadId: string | null;
  attachedToCurrentThread: boolean;
};

export function AttachTaskDialog({
  thread,
  open,
  onOpenChange,
}: {
  thread: PluginSidebarThread;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setTasks([]);
      setError(null);
      return;
    }
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setTasks([]);
      setLoading(false);
      setError(null);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void rpc.call("listAttachableTasks", { threadId: thread.id, query: normalizedQuery })
        .then((result) => {
          if (current) setTasks(result.tasks);
        })
        .catch((reason: unknown) => {
          if (!current) return;
          setTasks([]);
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 180);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [open, query, rpc, thread.id]);

  async function attach(task: Candidate) {
    if (task.attachedToCurrentThread) return;
    setAttachingId(`${task.source}:${task.id}`);
    setError(null);
    try {
      await rpc.call("attachThreadToTask", {
        source: task.source,
        taskId: task.id,
        threadId: thread.id,
      });
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAttachingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle>Attach chat to task</DialogTitle>
          <DialogDescription>
            Link “{thread.title ?? thread.titleFallback ?? "Untitled thread"}” to an existing task. This does not start a new chat.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label="Find a task"
          placeholder="Search by identifier or title…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="max-h-80 overflow-y-auto rounded-md border border-border p-1">
          <section aria-label="Tasks">
              {tasks.map((task) => {
                const itemId = `${task.source}:${task.id}`;
                const unavailable = Boolean(task.attachedThreadId && !task.attachedToCurrentThread);
                return (
                  <Button
                    key={itemId}
                    className="h-auto w-full justify-start gap-2 px-2 py-2 text-left font-normal"
                    disabled={attachingId !== null || unavailable || task.attachedToCurrentThread}
                    variant="ghost"
                    onClick={() => void attach(task)}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" name="ListTodo" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{task.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {task.identifier} · {task.status.replaceAll("_", " ")}
                      </span>
                    </span>
                    {task.attachedToCurrentThread ? (
                      <span className="text-xs text-muted-foreground">Attached</span>
                    ) : unavailable ? (
                      <span className="text-xs text-muted-foreground">Has chat</span>
                    ) : attachingId === itemId ? (
                      <Icon className="size-4 animate-spin" name="Loading" aria-label="Attaching" />
                    ) : null}
                  </Button>
                );
              })}
          </section>
          {loading ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">Finding tasks…</p>
          ) : !error && tasks.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {query.trim() ? "No matching tasks" : "Search by identifier or title"}
            </p>
          ) : null}
        </div>
        {error ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : null}
        <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
      </DialogContent>
    </Dialog>
  );
}
