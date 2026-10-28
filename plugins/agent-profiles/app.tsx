import { agentPreferencesContract } from "./server/preferences";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  Markdown,
  useBbNavigate,
  useComposer,
  useSdk,
  useRealtime,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Profile, rpcContract } from "./server/contract";
import { AGENTS_PROVIDER_ID, profileIdFromAgentModel, agentModelId } from "./server/provider-ids";
import { avatarEmojis, avatarIconName } from "./shared/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { profileInputFromProfile } from "./app/agents/profile-input";
import { longMemoryAction } from "./app/agents/long-memory-action";
import { channelWorkbenchTabs } from "./app/channels/workbench-tabs";
import { deferred } from "./app/shared/lazy";
import { Menu } from "./app/shared/menu";
import { discardDmDraftOffer, dmDraftOffer, offerDmDraft, subscribeDmDraftOffers } from "./app/shared/composer-draft";
import "./styles.css";

// Startup surfaces (directive, composer banners and settings) stay
// eager; the pages evaluate when first opened. See app/shared/lazy.tsx.
const AgentsSettings = deferred(() => import("./app/agents/agents-settings").then((module) => module.AgentsSettings));
const ChannelsPage = deferred(() => import("./app/channels/channels-page").then((module) => module.ChannelsPage));
const ChannelsHeader = deferred(() => import("./app/channels/channels-header").then((module) => module.ChannelsHeader));


type DelegationStatus = PluginRpcResult<(typeof rpcContract)["delegationStatus"]>;
type ThreadMember = PluginRpcResult<(typeof rpcContract)["threadMembers"]>[number];


function delegationDisplayStatus(status: string) {
  if (status === "error")
    return { label: "Error", dotClassName: "bg-destructive" };
  if (status === "active" || status === "pending" || status === "starting" || status === "stopping")
    return { label: "Working…", dotClassName: "bg-primary" };
  return { label: "Done", dotClassName: "bg-muted-foreground" };
}

// A compact outlined card, like inline-vis: agent pill, task, status. Expanding
// shows the instruction that was sent. Results and questions arrive as their
// own messages; the joined-agent pill above the composer owns promote/remove.
function DelegationDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const childThreadId = typeof attributes.threadId === "string" && attributes.threadId.length <= 100 ? attributes.threadId : "";
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<DelegationStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const load = useCallback(async () => {
    try {
      setState(await rpc.call("delegationStatus", { childThreadId, parentThreadId: message.threadId }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [childThreadId, message.threadId, rpc]);
  useEffect(() => { if (childThreadId) void load(); }, [childThreadId, load]);
  useRealtime("delegation-changed", useCallback((payload) => {
    if (!payload || typeof payload !== "object") return;
    const change = payload as Record<string, unknown>;
    if (change.threadId === childThreadId && change.parentThreadId === message.threadId) void load();
  }, [childThreadId, load, message.threadId]));
  if (failed || !childThreadId)
    return <div className="my-3 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">Delegated agent unavailable</div>;
  const displayStatus = state ? delegationDisplayStatus(state.status) : null;
  const title = state?.title?.replace(`${state.profile} · `, "") || "Delegated task";
  return (
    <section className="my-3 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex min-h-10 items-center gap-2 px-3 text-xs text-muted-foreground">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left disabled:cursor-default"
          aria-expanded={expanded}
          disabled={!state?.task}
          onClick={() => setExpanded((value) => !value)}
        >
          {state ? (
            <span className="inline-flex shrink-0 items-baseline gap-0.5 rounded-full border border-border bg-surface-raised/50 py-0.5 pl-1 pr-1.5 text-xs leading-4 text-foreground">
              <span aria-hidden>{state.avatar}</span>
              {state.profile}
            </span>
          ) : null}
          <span className="truncate opacity-70">{state ? title : "Delegating…"}</span>
        </button>
        {displayStatus ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${displayStatus.dotClassName}`} aria-hidden />
            {displayStatus.label}
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Open agent thread"
          title="Open agent thread"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => navigate.toThread(childThreadId)}
        >
          <Icon name="ExternalLink" className="size-3" />
        </button>
        {state?.task ? (
          <button
            type="button"
            aria-label={expanded ? "Hide instruction" : "Show instruction"}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon name="ChevronDown" className={`size-3.5 transition-transform ${expanded ? "" : "-rotate-90"}`} />
          </button>
        ) : null}
      </div>
      {expanded && state?.task ? (
        <div className="max-h-72 overflow-y-auto border-t border-border px-3 py-2 text-muted-foreground">
          <Markdown className="delegation-task text-xs leading-5" content={state.task} />
        </div>
      ) : null}
    </section>
  );
}

function JoinedAgentsBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : "";
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [members, setMembers] = useState<ThreadMember[]>([]);
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!threadId) return;
    try {
      setMembers(await rpc.call("threadMembers", { threadId }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load joined agents.");
    }
  }, [rpc, threadId]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("thread-members-changed", useCallback((payload) => {
    if (payload && typeof payload === "object" && (payload as Record<string, unknown>).threadId === threadId)
      void load();
  }, [load, threadId]));
  useRealtime("delegation-changed", useCallback((payload) => {
    if (payload && typeof payload === "object" && (payload as Record<string, unknown>).parentThreadId === threadId)
      void load();
  }, [load, threadId]));
  if (!threadId || members.length === 0) return null;
  const openChild = async (member: ThreadMember) => {
    if (!member.childThreadId) return;
    if (member.visibility === "hidden") {
      setBusyProfileId(member.profileId);
      try {
        await rpc.call("promoteDelegation", {
          childThreadId: member.childThreadId,
          parentThreadId: threadId,
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to promote delegated thread.");
        setBusyProfileId(null);
        return;
      }
      setBusyProfileId(null);
    }
    navigate.toThread(member.childThreadId);
  };
  const removeMember = async (member: ThreadMember) => {
    setBusyProfileId(member.profileId);
    try {
      await rpc.call("removeThreadMember", {
        threadId,
        profileId: member.profileId,
      });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove agent.");
    } finally {
      setBusyProfileId(null);
    }
  };
  // One pill per joined agent: avatar in place of "@", outline carries status.
  return (
    <div className="flex flex-wrap items-center gap-1 px-1" aria-label="Agents in this thread">
      {members.map((member) => {
        const displayStatus = member.childThreadId
          ? delegationDisplayStatus(member.status)
          : { ...delegationDisplayStatus(member.status), label: "Joined" };
        const busy = busyProfileId === member.profileId;
        const outline = displayStatus.label === "Working…"
          ? "border-primary"
          : displayStatus.label === "Error"
            ? "border-destructive"
            : "border-border";
        return (
          <Menu
            key={member.profileId}
            label={`@${member.slug}`}
            trigger={(
              <button
                type="button"
                title={`${member.name} · ${displayStatus.label}`}
                aria-label={`@${member.slug}, ${displayStatus.label}`}
                className={`flex h-6 items-center gap-1 rounded-full border bg-card pl-1.5 pr-2 text-xs font-medium hover:bg-state-hover ${outline}`}
              >
                <span aria-hidden className="text-[13px] leading-none">{member.avatar}</span>
                {member.slug}
              </button>
            )}
          >
            {member.childThreadId ? (
              <button type="button" className="flex h-7 w-full items-center rounded-sm px-2 text-left text-xs hover:bg-state-hover disabled:opacity-50" disabled={busy} onClick={() => void openChild(member)}>
                Open
              </button>
            ) : null}
            <button type="button" className="flex h-7 w-full items-center rounded-sm px-2 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50" disabled={busy} onClick={() => void removeMember(member)}>
              Remove
            </button>
          </Menu>
        );
      })}
    </div>
  );
}



function AgentsPreferences() {
  const rpc = useRpc<typeof rpcContract>();
  const preferencesRpc = useRpc<typeof agentPreferencesContract>();
  const [behavior, setBehavior] = useState<"directed" | "smart" | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setProfiles(await rpc.call("listProfiles"));
  }, [rpc]);

  useEffect(() => {
    void load().catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  }, [load]);
  useRealtime("profiles-changed", () => { void load(); });

  const selectDefault = async (profileId: string) => {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile || profile.isDefault) return;
    setBusy(true);
    try {
      await rpc.call("saveProfile", {
        ...profileInputFromProfile(profile),
        isDefault: true,
        expectedRevision: profile.revision,
      });
      await load();
      toast.success(`@${profile.slug} is now the default agent`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const loadPreferences = useCallback(() => { void preferencesRpc.call("agentPreferences", null).then(value => setBehavior(value.responseBehavior), () => toast.error("Could not load channel preference")); }, [preferencesRpc]);
  useEffect(loadPreferences, [loadPreferences]);
  useRealtime("agent-preferences", loadPreferences);
  const selected = profiles.find((profile) => profile.isDefault)?.id ?? "";
  return <section className="min-w-0 space-y-3" aria-label="Agent preferences">
    <h2 className="text-sm font-medium">Preferences</h2>
    <div className="@container min-w-0 divide-y divide-border rounded-md border border-border bg-surface-recessed/70 px-3">
    <div className="flex min-w-0 flex-col gap-2 py-3 @md:flex-row @md:items-center @md:justify-between">
      <label htmlFor="default-agent" className="text-sm">Default agent</label>
      <Select disabled={busy || profiles.length === 0} value={selected} onValueChange={value => void selectDefault(value)}>
        <SelectTrigger id="default-agent" className="w-full min-w-0 @md:w-72"><SelectValue placeholder={profiles.length ? "Choose an agent" : "Create an agent below"} /></SelectTrigger>
        <SelectContent>{profiles.map(profile => <SelectItem key={profile.id} value={profile.id}>{profile.name} (@{profile.slug})</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="flex min-w-0 flex-col gap-2 py-3 @md:flex-row @md:items-center @md:justify-between">
      <div className="min-w-0"><label htmlFor="channel-response-behavior" className="text-sm">New channel responses</label><p className="text-xs text-muted-foreground">Directed waits for mentions. Automatic chooses one agent.</p></div>
      <Select disabled={busy || behavior === null} value={behavior ?? ""} onValueChange={value => { setBusy(true); void preferencesRpc.call("updateAgentPreferences", { responseBehavior: value as "directed" | "smart" }).then(next => setBehavior(next.responseBehavior), () => toast.error("Could not save channel preference")).finally(() => setBusy(false)); }}>
        <SelectTrigger id="channel-response-behavior" className="w-full min-w-0 @md:w-72"><SelectValue placeholder="Loading…" /></SelectTrigger>
        <SelectContent><SelectItem value="directed">Directed</SelectItem><SelectItem value="smart">Automatic</SelectItem></SelectContent>
      </Select>
    </div>
    </div>
  </section>;
}

function AgentDmSelection() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const selection = composer.selection;
  const model = selection?.providerId === AGENTS_PROVIDER_ID ? selection.model : undefined;
  let profileId: string | null = null;
  if (model) {
    try { profileId = profileIdFromAgentModel(model); } catch { /* Not an agent model. */ }
  }
  const initial = useRef({ providerId: selection?.providerId, model });
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(initial.current.providerId === AGENTS_PROVIDER_ID);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (selection?.providerId !== AGENTS_PROVIDER_ID) setRestored(false);
  }, [selection?.providerId]);

  useEffect(() => {
    if (!profileId || composer.scope.kind !== "new-thread") return;
    if (initial.current.providerId === AGENTS_PROVIDER_ID && initial.current.model === undefined) {
      initial.current.model = model;
      return;
    }
    if (restored && initial.current.model === model) return;
    let current = true;
    composer.setInputLock(true);
    setOpening(true);
    setError(null);
    void rpc.call("ensureAgentDm", { profileId }).then(({ threadId }) => {
      if (!current || composer.selection?.providerId !== AGENTS_PROVIDER_ID || composer.selection.model !== model) return;
      offerDmDraft(threadId, composer.draft);
      navigate.toThread(threadId);
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (current) {
        composer.setInputLock(false);
        setOpening(false);
      }
    });
    return () => { current = false; composer.setInputLock(false); };
  }, [composer, model, navigate, profileId, restored, rpc]);

  if (composer.scope.kind !== "new-thread" || !profileId) return null;
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <span>{error ?? (opening ? "Opening agent DM…" : "Agents use one permanent DM. Your New thread draft stays here.")}</span>
      {restored && !opening ? (
        <Button size="sm" type="button" variant="outline" onClick={() => setRestored(false)}>
          Open DM
        </Button>
      ) : null}
    </div>
  );
}

function AgentDmComposerBanner() {
  const composer = useComposer();
  const sdk = useSdk();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : "";
  const [profileId, setProfileId] = useState<string | null>(null);
  const offer = useSyncExternalStore(subscribeDmDraftOffers, () => dmDraftOffer(threadId));
  const selection = composer.selection;

  useEffect(() => {
    if (!threadId) return;
    let current = true;
    setProfileId(null);
    void sdk.threads.getPluginMetadata({ threadId }).then((metadata) => {
      if (current && metadata.role === "dm" && metadata.schemaVersion === 1 &&
        typeof metadata.profileId === "string") {
        try {
          agentModelId(metadata.profileId);
          setProfileId(metadata.profileId);
        } catch { /* Ignore invalid metadata. */ }
      }
    }).catch(() => {});
    return () => { current = false; };
  }, [sdk, threadId]);

  useEffect(() => {
    if (!profileId || !selection ||
      (selection.providerId === AGENTS_PROVIDER_ID && selection.model === agentModelId(profileId))) return;
    let current = true;
    composer.setInputLock(true);
    void composer.setSelection({ providerId: AGENTS_PROVIDER_ID, model: agentModelId(profileId) })
      .catch(() => {})
      .finally(() => { if (current) composer.setInputLock(false); });
    return () => { current = false; composer.setInputLock(false); };
  }, [composer, profileId, selection?.providerId, selection?.model]);

  if (!profileId || !offer) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
      <span>A New thread draft is available. Your DM draft will not change unless you transfer it.</span>
      <Button size="sm" type="button" variant="outline" onClick={() => {
        composer.replace(offer);
        discardDmDraftOffer(threadId);
        composer.focus();
      }}>Replace DM draft</Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => discardDmDraftOffer(threadId)}>
        Keep DM draft
      </Button>
    </div>
  );
}


export default definePluginApp((app) => {
  for (const emoji of avatarEmojis) {
    app.experimental_icons.register({
      name: avatarIconName(emoji),
      component: ({ className }) => (
        <svg className={className} viewBox="0 0 32 32" aria-hidden>
          <text x="16" y="26" textAnchor="middle" fontSize="28" fontFamily="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">{emoji}</text>
        </svg>
      ),
    });
  }
  app.slots.experimental_threadAction(longMemoryAction);
  app.slots.messageDirective({ id: "agent-profile-delegation", component: DelegationDirective });
  app.composer.customize({
    id: "agent-dm",
    scopes: ["thread"],
    banners: [{ id: "agent-dm", chrome: "bare", component: AgentDmComposerBanner }],
  });
  app.composer.customize({
    id: "agent-profile",
    scopes: ["new-thread"],
    banners: [{ id: "agent-dm-selection", chrome: "bare", component: AgentDmSelection }],
  });
  app.slots.navPanel({
    id: "channels",
    title: "Channels",
    icon: "MessageSquare",
    path: "channels",
    component: ChannelsPage,
    headerContent: ChannelsHeader,
  });
  for (const tab of channelWorkbenchTabs) app.slots.experimental_tab(tab);
  app.slots.settingsSection({ id: "preferences", component: AgentsPreferences });
  app.slots.settingsSection({ id: "agents", component: AgentsSettings });
});
