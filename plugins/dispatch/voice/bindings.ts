// How the call reaches this realm's screen (SPEC §6.1, §6.3). The composer
// controls register composer bindings: the draft, send, and navigation. The
// bindings overlay registers fallback bindings with navigation only, for
// screens that have no composer. The latest composer binding wins; the latest
// fallback is used when no composer is mounted.

import {
  experimental_useAppPanel,
  useBbContext,
  useBbNavigate,
  useSdk,
  type ComposerDraftSnapshot,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useRef } from "react";
import { VIEWS_PANEL_ACTION, VIEWS_TAB, NAV_PANEL } from "@/app/ids.js";

export type Split = "right" | "left" | "down" | "top";
export type PaneAction = "spotlight" | "clear-spotlight" | "maximize" | "restore" | "toggle";

export interface ScreenContext {
  threadId: string | null;
  projectId: string | null;
  onNewThreadScreen: boolean;
}

export interface ThreadInfo {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
}

export interface NavBindings {
  toThread(threadId: string): void;
  /** Resolves false when no window took the split. */
  openSplit(threadId: string, split: Split): Promise<boolean>;
  toCompose(options: { projectId?: string; hostId?: string }): void;
  /** Bring the mobile drawer on screen. False when nothing could open it. */
  openDrawer(): boolean;
  /** Resolves with the number of windows that applied the action. */
  paneAction(threadId: string, action: PaneAction): Promise<number>;
  thread(threadId: string): Promise<ThreadInfo | null>;
  latestOutput(threadId: string): Promise<string | null>;
}

export interface ComposerBindings {
  draft(): ComposerDraftSnapshot;
  replace(next: ComposerDraftSnapshot): void;
  /** Rejects with a message safe to show when sending is blocked. */
  submit(): Promise<void>;
  focus(): void;
}

export interface Bindings {
  kind: "composer" | "fallback";
  context(): ScreenContext;
  nav: NavBindings;
  composer: ComposerBindings | null;
}

const registered: Bindings[] = [];

export function registerBindings(bindings: Bindings): () => void {
  registered.push(bindings);
  return () => {
    const at = registered.lastIndexOf(bindings);
    if (at !== -1) registered.splice(at, 1);
  };
}

/** The bindings a tool uses now, or null before anything mounted. */
export function currentBindings(): Bindings | null {
  for (let at = registered.length - 1; at >= 0; at -= 1) if (registered[at]!.kind === "composer") return registered[at]!;
  return registered.at(-1) ?? null;
}

/** Navigation from BB's hooks. Call it in a mounted component. */
export function useNavBindings(): NavBindings {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const panel = experimental_useAppPanel();
  const latest = useRef({ navigate, sdk, panel });
  latest.current = { navigate, sdk, panel };
  const nav = useRef<NavBindings | null>(null);
  nav.current ??= {
    toThread: (threadId) => latest.current.navigate.toThread(threadId),
    async openSplit(threadId, split) {
      const result = await latest.current.sdk.threads.open({ threadId, split, file: null });
      return result.delivered > 0;
    },
    toCompose: (options) => latest.current.navigate.toCompose({ ...options, focusPrompt: true }),
    openDrawer() {
      const { navigate: go, panel: app } = latest.current;
      // In a thread the panel action opens beside the chat. Elsewhere the console's Views tab.
      if (go.openThreadPanel({ actionId: VIEWS_PANEL_ACTION.id })) return true;
      if (app.openFixedTab({ surface: { kind: "current" }, tab: { panelId: VIEWS_TAB.panelId, id: VIEWS_TAB.id } })) return true;
      go.toPluginPanel(NAV_PANEL.path);
      return true;
    },
    async paneAction(threadId, action) {
      const result = await latest.current.sdk.threads.paneAction({ threadId, action });
      return result.delivered;
    },
    async thread(threadId) {
      try {
        const thread = await latest.current.sdk.threads.get({ threadId });
        return {
          id: thread.id,
          title: thread.title ?? thread.titleFallback ?? "Untitled thread",
          status: String(thread.status),
          projectId: thread.projectId ?? null,
        };
      } catch {
        return null;
      }
    },
    async latestOutput(threadId) {
      try {
        return (await latest.current.sdk.threads.output({ threadId })).output;
      } catch {
        return null;
      }
    },
  };
  return nav.current;
}

/**
 * Register bindings while the calling component is mounted. `composer` and
 * `context` may change on every render; the registered entry reads the latest.
 */
export function useRegisterBindings(kind: Bindings["kind"], context: ScreenContext, composer: ComposerBindings | null) {
  const nav = useNavBindings();
  const latest = useRef({ context, composer });
  latest.current = { context, composer };
  useEffect(
    () =>
      registerBindings({
        kind,
        context: () => latest.current.context,
        nav,
        get composer() {
          return latest.current.composer;
        },
      }),
    [kind, nav],
  );
}

/** The screen context outside a composer. */
export function useScreenContext(): ScreenContext {
  const { threadId, projectId } = useBbContext();
  return { threadId, projectId, onNewThreadScreen: false };
}
