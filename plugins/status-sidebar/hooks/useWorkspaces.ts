import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  DEFAULT_WORKSPACE_ID,
  WORKSPACES_CHANNEL,
  type SidebarWorkspace,
} from "../shared";

const fallbackWorkspace: SidebarWorkspace = {
  id: DEFAULT_WORKSPACE_ID,
  name: "General",
  color: "amber",
  isDefault: true,
  projectIds: [],
  threadIds: [],
};

export function useWorkspaces() {
  const rpc = useRpc<typeof rpcContract>();
  const [workspaces, setWorkspaces] = useState<readonly SidebarWorkspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const refreshGeneration = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const result = await rpc.call("listWorkspaces");
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setWorkspaces(result.workspaces);
      setError(null);
      setStatus("ready");
    } catch (cause) {
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load sidebar groups.");
      setWorkspaces((current) => current.length ? current : [fallbackWorkspace]);
      setStatus("ready");
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime(WORKSPACES_CHANNEL, () => {
    void refresh();
  });
  const defaultWorkspaceId =
    workspaces.find((workspace) => workspace.isDefault)?.id ??
    DEFAULT_WORKSPACE_ID;
  const projectWorkspaceById = useMemo(
    () =>
      new Map(
        workspaces.flatMap((workspace) =>
          workspace.projectIds.map(
            (projectId) => [projectId, workspace.id] as const,
          ),
        ),
      ),
    [workspaces],
  );
  const threadWorkspaceById = useMemo(
    () =>
      new Map(
        workspaces.flatMap((workspace) =>
          workspace.threadIds.map(
            (threadId) => [threadId, workspace.id] as const,
          ),
        ),
      ),
    [workspaces],
  );
  const assignProject = useCallback(
    async (projectId: string, workspaceId: string) => {
      setWorkspaces((current) =>
        current.map((workspace) => ({
          ...workspace,
          projectIds:
            workspace.id === workspaceId
              ? [...workspace.projectIds.filter((id) => id !== projectId), projectId]
              : workspace.projectIds.filter((id) => id !== projectId),
        })),
      );
      try {
        await rpc.call("setProjectWorkspace", { projectId, workspaceId });
      } catch (error) {
        await refresh();
        throw error;
      }
    },
    [refresh, rpc],
  );
  const create = useCallback(
    async (name: string) => {
      const result = await rpc.call("createWorkspace", { name });
      await refresh();
      return result.workspaceId;
    },
    [refresh, rpc],
  );
  const rename = useCallback(
    async (workspaceId: string, name: string) => {
      await rpc.call("renameWorkspace", { workspaceId, name });
      await refresh();
    },
    [refresh, rpc],
  );
  const remove = useCallback(
    async (workspaceId: string) => {
      await rpc.call("deleteWorkspace", { workspaceId });
      await refresh();
    },
    [refresh, rpc],
  );
  const reorderWorkspaces = useCallback(
    async (workspaceIds: readonly string[]) => {
      setWorkspaces((current) => {
        const byId = new Map(current.map((workspace) => [workspace.id, workspace]));
        return workspaceIds.flatMap((id) => byId.get(id) ?? []);
      });
      try {
        await rpc.call("setWorkspaceOrder", { workspaceIds: [...workspaceIds] });
      } catch (error) {
        await refresh();
        throw error;
      }
    },
    [refresh, rpc],
  );

  const assignThread = useCallback(
    async (threadId: string, workspaceId: string) => {
      setWorkspaces((current) =>
        current.map((workspace) => ({
          ...workspace,
          threadIds:
            workspace.id === workspaceId
              ? [...workspace.threadIds.filter((id) => id !== threadId), threadId]
              : workspace.threadIds.filter((id) => id !== threadId),
        })),
      );
      try {
        await rpc.call("setThreadWorkspace", { threadId, workspaceId });
      } catch (error) {
        await refresh();
        throw error;
      }
    },
    [refresh, rpc],
  );

  const clearThreadWorkspace = useCallback(
    async (threadId: string) => {
      setWorkspaces((current) =>
        current.map((workspace) => ({
          ...workspace,
          threadIds: workspace.threadIds.filter((id) => id !== threadId),
        })),
      );
      try {
        await rpc.call("clearThreadWorkspace", { threadId });
      } catch (error) {
        await refresh();
        throw error;
      }
    },
    [refresh, rpc],
  );

  const reorderProjects = useCallback(
    async (workspaceId: string, projectIds: readonly string[]) => {
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, projectIds: [...projectIds] }
            : workspace,
        ),
      );
      try {
        await rpc.call("setProjectOrder", {
          workspaceId,
          projectIds: [...projectIds],
        });
      } catch (error) {
        await refresh();
        throw error;
      }
    },
    [refresh, rpc],
  );

  return {
    status,
    error,
    workspaces,
    defaultWorkspaceId,
    projectWorkspaceById,
    threadWorkspaceById,
    create,
    rename,
    remove,
    reorderWorkspaces,
    assignProject,
    assignThread,
    clearThreadWorkspace,
    reorderProjects,
  };
}
