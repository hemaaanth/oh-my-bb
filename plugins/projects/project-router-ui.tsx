import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useComposer,
  useRpc,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { createProjectRouterStatusTarget } from "./project-router-placement";
// Type-only from ./contract: its zod schemas stay out of the frontend bundle.
import type { rpcContract } from "./contract";

type ProjectSuggestionResult = PluginRpcResult<(typeof rpcContract)["suggestProject"]>;

const routerSession: {
  active: boolean;
  currentProjectId: string | null | undefined;
  pendingProjectId: string | null;
  manualOverride: boolean;
} = {
  active: false,
  currentProjectId: undefined,
  pendingProjectId: null,
  manualOverride: false,
};
let routerResetTimer: ReturnType<typeof setTimeout> | null = null;

function resetRouterSession() {
  routerSession.active = false;
  routerSession.currentProjectId = undefined;
  routerSession.pendingProjectId = null;
  routerSession.manualOverride = false;
}

function ProjectRouterStatusPlacement({ children }: { children: ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const placement = createProjectRouterStatusTarget(anchor);
    if (!placement) return;
    setTarget(placement.target);
    return placement.dispose;
  }, []);

  const status = (
    <div className="flex h-5 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs" role="status">
      {children}
    </div>
  );
  return (
    <>
      <span ref={anchorRef} aria-hidden data-jev-project-router-anchor="" className="hidden" />
      {target ? createPortal(status, target) : status}
    </>
  );
}

const NO_PROJECT_SUGGESTION = "no_project";
// The native "Forking …" chip. A fork draft locks its project, so Jev must not route it.
const FORK_DRAFT_SELECTOR = 'button[aria-label="Cancel fork"]';

export function ProjectRouterBanner() {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [isForkDraft, setIsForkDraft] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    const composer = anchorRef.current?.closest<HTMLElement>('[data-app-composer-role="primary"]');
    if (!composer) {
      setIsForkDraft(false);
      return;
    }
    const update = () => setIsForkDraft(composer.querySelector(FORK_DRAFT_SELECTOR) !== null);
    update();
    const observer = new MutationObserver(update);
    observer.observe(composer, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <span ref={anchorRef} aria-hidden className="hidden" />
      {isForkDraft === null ? null : isForkDraft ? (
        <ProjectRouterStatusPlacement>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          <span className="truncate text-muted-foreground">Jev is off · forks keep their project.</span>
        </ProjectRouterStatusPlacement>
      ) : <ProjectRouter />}
    </>
  );
}

function ProjectRouter() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const sidebar = useSidebarThreads();
  const prompt = composer.draft.text.trim();
  const projectId = composer.scope.kind === "new-thread" ? composer.scope.projectId : null;
  const [result, setResult] = useState<ProjectSuggestionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOverride, setManualOverride] = useState(routerSession.manualOverride);
  const requestSequence = useRef(0);
  const stableSuggestionId = useRef<string | null | undefined>(undefined);
  const hasResolvedSuggestion = useRef(false);

  useEffect(() => {
    if (routerResetTimer) {
      clearTimeout(routerResetTimer);
      routerResetTimer = null;
    }
    return () => {
      routerResetTimer = setTimeout(resetRouterSession, 1_500);
    };
  }, []);

  useEffect(() => {
    if (!prompt) {
      resetRouterSession();
      setManualOverride(false);
      setResult(null);
      setError(null);
      return;
    }
    if (!routerSession.active) {
      routerSession.active = true;
      routerSession.currentProjectId = projectId;
    } else if (routerSession.pendingProjectId === projectId) {
      routerSession.pendingProjectId = null;
      routerSession.currentProjectId = projectId;
    } else if (
      routerSession.currentProjectId !== undefined
      && routerSession.currentProjectId !== projectId
    ) {
      routerSession.currentProjectId = projectId;
      routerSession.manualOverride = true;
    }
    setManualOverride(routerSession.manualOverride);
  }, [projectId, prompt]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    if (prompt.length < 10) {
      stableSuggestionId.current = undefined;
      hasResolvedSuggestion.current = false;
      setResult(null);
      setLoading(false);
      return;
    }
    if (!hasResolvedSuggestion.current) setLoading(true);
    void rpc.call("suggestProject", { prompt }).then((next) => {
      if (requestSequence.current !== sequence) return;
      const nextSuggestionId = next.suggestion?.id ?? (next.noProject ? NO_PROJECT_SUGGESTION : null);
      if (
        stableSuggestionId.current === undefined
        || stableSuggestionId.current !== nextSuggestionId
      ) {
        stableSuggestionId.current = nextSuggestionId;
        setResult(next);
      }
      hasResolvedSuggestion.current = true;
      setError(null);
    }).catch((cause) => {
      if (requestSequence.current !== sequence) return;
      if (!hasResolvedSuggestion.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setResult(null);
      }
    }).finally(() => {
      if (requestSequence.current === sequence) setLoading(false);
    });
  }, [prompt, rpc]);

  const applyProject = useCallback((nextProjectId: string) => {
    routerSession.pendingProjectId = nextProjectId;
    routerSession.manualOverride = false;
    routerSession.currentProjectId = projectId;
    setManualOverride(false);
    // Use the picker path so BB preserves draft attachments when the project changes.
    const keepCurrentProject = () => {
      if (routerSession.pendingProjectId !== nextProjectId) return;
      routerSession.pendingProjectId = null;
      routerSession.manualOverride = true;
      setManualOverride(true);
    };
    void composer.setSelection({ projectId: nextProjectId }).then(
      (selection) => {
        if (selection.projectId !== nextProjectId) keepCurrentProject();
      },
      keepCurrentProject,
    );
  }, [composer, projectId]);

  useEffect(() => {
    const suggestion = result?.suggestion;
    if (
      suggestion
      && result.autoApply
      && !manualOverride
      && !routerSession.manualOverride
      && projectId !== suggestion.id
      && routerSession.pendingProjectId !== suggestion.id
    ) {
      applyProject(suggestion.id);
    }
  }, [applyProject, manualOverride, projectId, result]);

  const currentProjectName = useMemo(
    () => sidebar.projects.find((project) => project.id === projectId)?.name ?? null,
    [projectId, sidebar.projects],
  );
  const personalProjectId = useMemo(
    () => sidebar.projects.find((project) => project.isPersonal)?.id ?? null,
    [sidebar.projects],
  );

  if (prompt.length < 10) {
    return (
      <ProjectRouterStatusPlacement>
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
        <span className="truncate text-muted-foreground">Jev is idle.</span>
      </ProjectRouterStatusPlacement>
    );
  }
  if (loading && !result) {
    return (
      <ProjectRouterStatusPlacement>
        <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
        <span className="truncate text-muted-foreground">Jev is finding the right project…</span>
      </ProjectRouterStatusPlacement>
    );
  }
  if (error) {
    return (
      <ProjectRouterStatusPlacement>
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
        <span className="truncate text-destructive">Project routing paused: {error}</span>
      </ProjectRouterStatusPlacement>
    );
  }
  if (!result?.suggestion && result?.noProject && personalProjectId) {
    const percentage = Math.round(result.noProject.probability * 100);
    const isSelected = projectId === personalProjectId;
    return (
      <ProjectRouterStatusPlacement>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", isSelected ? "bg-success" : "bg-primary")} />
        <span className="min-w-0 truncate text-muted-foreground">
          {isSelected ? "Jev agrees this needs no project." : "Jev suggests working without a project."}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-subtle-foreground/70">{percentage}%</span>
        {isSelected ? null : (
          <button className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline" onClick={() => applyProject(personalProjectId)} type="button">Start without a project</button>
        )}
      </ProjectRouterStatusPlacement>
    );
  }
  if (!result?.suggestion) {
    return (
      <ProjectRouterStatusPlacement>
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
        <span className="truncate text-muted-foreground">Jev is idle · no confident project match.</span>
      </ProjectRouterStatusPlacement>
    );
  }

  const suggestion = result.suggestion;
  const percentage = Math.round(suggestion.probability * 100);
  const isSelected = projectId === suggestion.id && !manualOverride;
  const canApplySuggestion = manualOverride || (!result.autoApply && !isSelected);
  return (
    <ProjectRouterStatusPlacement>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", isSelected ? "bg-success" : "bg-primary")} />
      <span className="min-w-0 truncate text-muted-foreground">
        {manualOverride
          ? <>Keeping <span className="font-medium text-foreground">{currentProjectName ?? "your project choice"}</span>. Jev suggests <span className="font-medium text-foreground" title={suggestion.summary}>{suggestion.name}</span>.</>
          : isSelected
            ? <>{result.autoApply ? "Jev routed this thread to " : "Jev agrees with "}<span className="font-medium text-foreground" title={suggestion.summary}>{suggestion.name}</span>.</>
            : result.autoApply
              ? <>Routing to <span className="font-medium text-foreground" title={suggestion.summary}>{suggestion.name}</span>…</>
              : <>Jev suggests <span className="font-medium text-foreground" title={suggestion.summary}>{suggestion.name}</span>.</>}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-subtle-foreground/70">{percentage}%</span>
      {canApplySuggestion ? (
        <button className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline" onClick={() => applyProject(suggestion.id)} type="button">Use suggestion</button>
      ) : null}
    </ProjectRouterStatusPlacement>
  );
}

