import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { EmptyStatePanel } from "@/components/ui/empty-state";

type ActionView = {
  id: string;
  name: string;
  command: string;
  description: string | null;
  type: "command" | "service";
  source: "script" | "worktree-terminal";
  autostart: boolean;
  running: boolean;
  terminalId: string | null;
  port: number | null;
};

type Snapshot = {
  available: true;
  workspacePath: string;
  manifestFound: boolean;
  setup: { source: "bb" | "paseo" } | null;
  teardown: { source: "bb" | "paseo" } | null;
  actions: ActionView[];
} | {
  available: false;
  message: string;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ActionRow({
  action,
  busy,
  onRun,
  onStop,
}: {
  action: ActionView;
  busy: boolean;
  onRun: (action: ActionView) => void;
  onStop: (action: ActionView) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{action.name}</span>
          {action.type === "service" ? (
            <span className="shrink-0 text-xs text-muted-foreground">Service</span>
          ) : null}
          {action.running ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-primary">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              Running{action.port ? ` on ${action.port}` : ""}
            </span>
          ) : null}
        </div>
        {action.description ? (
          <p className="mt-1 text-xs text-muted-foreground">{action.description}</p>
        ) : null}
        <code
          className="mt-1 block truncate text-xs text-muted-foreground"
          title={action.command}
        >
          {action.command}
        </code>
      </div>
      {action.running ? (
        <Button
          aria-label={`Stop ${action.name}`}
          disabled={busy}
          onClick={() => onStop(action)}
          size="sm"
          type="button"
          variant="outline"
        >
          Stop
        </Button>
      ) : (
        <Button
          aria-label={`Run ${action.name}`}
          disabled={busy}
          onClick={() => onRun(action)}
          size="sm"
          type="button"
        >
          <Icon aria-hidden="true" name="Play" />
          Run
        </Button>
      )}
    </div>
  );
}

function WorkspaceScriptsPanel({ threadId: panelThreadId, params }: { threadId: string; params: JsonValue | null }) {
  const threadId = params !== null && typeof params === "object" && !Array.isArray(params) && typeof params.threadId === "string"
    ? params.threadId : panelThreadId;
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      setSnapshot((await rpc.call("inspect", { threadId })) as Snapshot);
    } catch (cause) {
      setSnapshot(null);
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [rpc, threadId]);

  useEffect(() => { void load(); }, [load]);
  useRealtime("workspace-scripts", () => { void load(); });

  const runAction = async (action: ActionView) => {
    setBusyId(action.id);
    setError(null);
    setNotice(null);
    try {
      const result = await rpc.call("run", { threadId, actionId: action.id });
      setNotice(
        result.reused
          ? `${action.name} is already running.`
          : `${action.name} started in terminal ${result.terminalId}.`,
      );
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusyId(null);
    }
  };

  const stopAction = async (action: ActionView) => {
    setBusyId(action.id);
    setError(null);
    setNotice(null);
    try {
      await rpc.call("stopService", { threadId, actionId: action.id });
      setNotice(`${action.name} stopped.`);
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusyId(null);
    }
  };

  const runSetup = async () => {
    setBusyId("setup");
    setError(null);
    setNotice(null);
    try {
      const result = await rpc.call("runHook", { threadId, phase: "setup" });
      setNotice(`Workspace setup started in terminal ${result.terminalId}.`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusyId(null);
    }
  };

  const availableSnapshot = snapshot?.available ? snapshot : null;
  const unavailableMessage = snapshot?.available === false ? snapshot.message : null;
  const scripts = availableSnapshot?.actions.filter((action) => action.source === "script") ?? [];
  const workspaceServices =
    availableSnapshot?.actions.filter((action) => action.source === "worktree-terminal") ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">Scripts</h2>
        <p className="truncate text-xs text-muted-foreground" title={availableSnapshot?.workspacePath}>
          {availableSnapshot?.workspacePath ?? "Commands declared by this checkout"}
        </p>
      </div>

      {!loading && unavailableMessage ? (
        <EmptyStatePanel role="status">
          {unavailableMessage}
        </EmptyStatePanel>
      ) : null}

      {availableSnapshot?.setup ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Set up workspace</p>
            <p className="text-xs text-muted-foreground">
              {availableSnapshot.setup.source === "bb" ? ".bb-env-setup.sh" : "paseo.json worktree.setup"}
            </p>
          </div>
          <Button
            disabled={busyId !== null}
            onClick={() => void runSetup()}
            size="sm"
            type="button"
            variant="outline"
          >
            {busyId === "setup" ? <Icon aria-hidden="true" className="animate-spin" name="Loading" /> : null}
            Set up
          </Button>
        </div>
      ) : null}

      {workspaceServices.length > 0 ? (
        <section aria-labelledby="workspace-services-heading" className="space-y-2">
          <div>
            <h3 className="text-sm font-medium text-foreground" id="workspace-services-heading">
              Workspace services
            </h3>
            <p className="text-xs text-muted-foreground">Started automatically when the workspace becomes active.</p>
          </div>
          {workspaceServices.map((action) => (
            <ActionRow
              action={action}
              busy={busyId !== null}
              key={action.id}
              onRun={(selected) => void runAction(selected)}
              onStop={(selected) => void stopAction(selected)}
            />
          ))}
        </section>
      ) : null}

      {scripts.length > 0 ? (
        <section aria-labelledby="scripts-heading" className="space-y-2">
          <h3 className="text-sm font-medium text-foreground" id="scripts-heading">Scripts</h3>
          {scripts.map((action) => (
            <ActionRow
              action={action}
              busy={busyId !== null}
              key={action.id}
              onRun={(selected) => void runAction(selected)}
              onStop={(selected) => void stopAction(selected)}
            />
          ))}
        </section>
      ) : null}

      {!loading && availableSnapshot && !availableSnapshot.setup && availableSnapshot.actions.length === 0 ? (
        <EmptyStatePanel className="rounded-lg p-4">
          This checkout does not declare workspace scripts or setup.
        </EmptyStatePanel>
      ) : null}
      {loading && !snapshot ? (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Icon aria-hidden="true" className="animate-spin" name="Loading" />
          Loading workspace scripts…
        </p>
      ) : null}
      <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground" role="status">
        {notice}
      </p>
      {error ? (
        <p className="whitespace-pre-wrap rounded-lg bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "scripts",
    title: "Scripts",
    icon: "Terminal",
    component: WorkspaceScriptsPanel,
  });
  app.slots.experimental_threadAction({
    id: "scripts",
    title: "Scripts",
    icon: "Terminal",
    group: "machine",
    item: ({ thread, navigate }) => ({
      label: "Scripts",
      icon: "Terminal",
      run: () => { navigate.openThreadPanel({ actionId: "scripts", params: { threadId: thread.id } }); },
    }),
  });
  app.commands.register({
    id: "scripts",
    title: "Open workspace scripts",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => { openPanel({ actionId: "scripts" }); },
  });
});
