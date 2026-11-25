import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  ThreadChat,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { Profile, rpcContract } from "../../server/contract";
import { AgentDetail, agentTabs } from "./agent-detail";
import { ProfileForm } from "./profile-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorMessage, message } from "../shared/ui";

const LAST_BOT_KEY = "agent-profiles:last-bot-slug";
let cachedProfiles: Profile[] | null = null;
const dmThreadCache = new Map<string, string>();

function useBotsList() {
  const rpc = useRpc<typeof rpcContract>();
  const [profiles, setProfiles] = useState<Profile[]>(() => cachedProfiles ?? []);
  const [loaded, setLoaded] = useState(() => cachedProfiles !== null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const seq = ++request.current;
    try {
      const next = await rpc.call("listProfiles");
      if (seq !== request.current) return;
      cachedProfiles = next;
      setProfiles(next);
      setError(null);
      setLoaded(true);
    } catch (cause) {
      if (seq === request.current) {
        setError(message(cause));
        setLoaded(true);
      }
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    return () => { request.current++; };
  }, [load]);

  useRealtime("profiles-changed", useCallback(() => { void load(); }, [load]));

  const sorted = [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  return { profiles: sorted, loaded, error, reload: load };
}

function activeSlugFromSubPath(subPath: string): string | null {
  const clean = subPath.replace(/^\/+|\/+$/gu, "").split("/")[0] ?? "";
  if (!clean) return null;
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

/** Dedicated left sidebar for the Bots rail space — replaces the regular thread sidebar completely. */
export function BotsSidebar({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const { profiles, loaded, error, reload } = useBotsList();
  const [editing, setEditing] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof agentTabs)[number]>("profile");
  const activeSlug = activeSlugFromSubPath(subPath);
  const editingProfile = profiles.find((item) => item.id === editing);

  const selectBot = (profile: Profile) => {
    try {
      window.localStorage.setItem(LAST_BOT_KEY, profile.slug);
    } catch {
      // Ignore storage errors.
    }
    navigate.toPluginPanel("bots", { subPath: encodeURIComponent(profile.slug) });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Bots{loaded ? ` · ${profiles.length}` : ""}
        </span>
        <span title="New bot" className="inline-flex">
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-sidebar-foreground"
            aria-label="New bot"
            disabled={!loaded || !!error}
            onClick={() => setEditing("new")}
          >
            <Icon name="Plus" className="size-4" aria-hidden />
          </Button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {error ? (
          <p role="alert" className="px-2 py-2 text-xs text-destructive-text">{error}</p>
        ) : !loaded ? (
          <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Loading bots…</p>
        ) : profiles.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">No bots yet.</p>
        ) : (
          <ul className="space-y-0.5" aria-label="Bots">
            {profiles.map((bot) => {
              const selected = activeSlug === bot.slug;
              return (
                <li key={bot.id} className="group relative flex items-center">
                  <button
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    onClick={() => selectBot(bot)}
                    className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                      selected
                        ? "bg-sidebar-accent font-medium text-sidebar-foreground"
                        : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                    }`}
                  >
                    <span aria-hidden className="grid size-5 shrink-0 place-items-center text-sm leading-none">
                      {bot.avatar}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${bot.name}`}
                    title={`Edit ${bot.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setTab("profile");
                      setEditing(bot.id);
                    }}
                    className="absolute right-1 inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Icon name="Edit" className="size-3" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        {editing !== null ? (
          <DialogContent aria-describedby={undefined} className="agent-settings-editor h-[85dvh] w-[calc(100%-2rem)] max-w-[760px] overflow-y-auto">
            <DialogHeader className={editing === "new" ? undefined : "sr-only"}>
              <DialogTitle>{editing === "new" ? "New bot" : editingProfile?.name ?? "Bot unavailable"}</DialogTitle>
            </DialogHeader>
            {editing === "new" ? (
              <ProfileForm
                makeDefault={profiles.length === 0}
                onSaved={async () => { await reload(); setEditing(null); }}
                onCancel={() => setEditing(null)}
              />
            ) : editingProfile ? (
              <AgentDetail
                key={editingProfile.id}
                profile={editingProfile}
                tab={tab}
                onReload={reload}
                onBack={() => setEditing(null)}
                onTab={setTab}
              />
            ) : (
              <p className="text-sm text-muted-foreground">This bot is no longer available.</p>
            )}
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

/** Main pane for the Bots rail space — opens a direct 1-on-1 chat with the selected bot. */
export function BotsPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { profiles, loaded, error } = useBotsList();
  const activeSlug = activeSlugFromSubPath(subPath);
  const selectedBot = profiles.find((bot) => bot.slug === activeSlug) ?? null;

  // Auto-select the last-chatted (or first) bot when opening /bots with no subPath.
  useEffect(() => {
    if (!loaded || activeSlug || profiles.length === 0) return;
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(LAST_BOT_KEY);
    } catch {
      saved = null;
    }
    const target = profiles.find((bot) => bot.slug === saved) ?? profiles[0];
    if (target) {
      navigate.toPluginPanel("bots", { subPath: encodeURIComponent(target.slug), replace: true });
    }
  }, [loaded, activeSlug, profiles, navigate]);

  const [threadId, setThreadId] = useState<string | null>(() =>
    selectedBot ? (dmThreadCache.get(selectedBot.id) ?? null) : null,
  );
  const [dmError, setDmError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedBot) {
      setThreadId(null);
      return;
    }
    const cached = dmThreadCache.get(selectedBot.id);
    if (cached) {
      setThreadId(cached);
      setDmError(null);
      return;
    }
    let alive = true;
    setThreadId(null);
    setDmError(null);
    void rpc.call("ensureAgentDm", { profileId: selectedBot.id }).then(
      (res) => {
        if (!alive) return;
        dmThreadCache.set(selectedBot.id, res.threadId);
        setThreadId(res.threadId);
      },
      (cause) => {
        if (!alive) return;
        setDmError(message(cause));
      },
    );
    return () => { alive = false; };
  }, [rpc, selectedBot]);

  if (error) {
    return <div className="p-6"><ErrorMessage error={error} /></div>;
  }
  if (!loaded) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading bots…</div>;
  }
  if (profiles.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No bots yet. Create one from the sidebar.</div>;
  }
  if (!selectedBot) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a bot in the sidebar to start chatting.</div>;
  }
  if (dmError) {
    return <div className="p-6"><ErrorMessage error={dmError} /></div>;
  }
  if (!threadId) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Opening chat with {selectedBot.name}…</div>;
  }

  return (
    <div key={threadId} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <ThreadChat threadId={threadId} />
    </div>
  );
}
