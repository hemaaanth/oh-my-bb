import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useRpc, useSdk, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { Profile, ProfileInput, rpcContract } from "../../server/contract";
import { modelLevelLabel, modelLevels } from "../../server/model-levels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  parseIds,
  profileDraft,
  profileInputFromProfile,
  readConfigDraft,
  writeConfigDraft,
} from "./config-draft";
import { ConfigRow, ConfigSection, ErrorMessage, message } from "../shared/ui";


function defaultProfile(isDefault: boolean): ProfileInput {
  return {
    kind: "full",
    name: "",
    slug: "",
    description: "",
    avatar: "🤖",
    modelMode: "level",
    level: "medium",
    providerId: "hempi",
    model: "openai-codex/gpt-6-sol",
    reasoningLevel: "medium",
    serviceTier: "default",
    permissionMode: "auto",
    instructions: "",
    skillIds: [],
    mcpServerIds: [],
    runProjectId: null,
    runHostId: null,
    runInCheckout: false,
    showInSidebar: true,
    isDefault,
  };
}

function sameProfile(left: ProfileInput, right: ProfileInput) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function ProfileForm({
  profile,
  makeDefault = false,
  onSaved,
  onCancel,
}: {
  profile?: Profile;
  makeDefault?: boolean;
  onSaved: (profile: Profile) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const draftKey = `bb:agents:profile:${profile?.id ?? "new"}`;
  const [restored] = useState(() => readConfigDraft(draftKey, profileDraft));
  const initial = profile ? profileInputFromProfile(profile) : defaultProfile(makeDefault);
  const [draft, setDraft] = useState<ProfileInput>(restored?.draft ?? initial);
  const [baseline, setBaseline] = useState<ProfileInput>(restored?.baseline ?? initial);
  const [skillIdsText, setSkillIdsText] = useState(restored?.skillIdsText ?? initial.skillIds.join(", "));
  const [mcpServerIdsText, setMcpServerIdsText] = useState(restored?.mcpServerIdsText ?? initial.mcpServerIds.join(", "));
  const [revision, setRevision] = useState<number | null>(restored?.revision ?? profile?.revision ?? null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levelPreview, setLevelPreview] = useState<
    PluginRpcResult<(typeof rpcContract)["modelLevelPreview"]> | null
  >(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [piModels, setPiModels] = useState<PluginRpcResult<(typeof rpcContract)["models"]>>([]);
  const [runsInLocked, setRunsInLocked] = useState(!!profile);
  const submitting = useRef(false);
  const id = useId();
  const prepared = useMemo(() => ({
    ...draft,
    name: draft.name.trim(),
    slug: draft.slug.trim().toLowerCase(),
    description: draft.description.trim(),
    instructions: draft.instructions.trim(),
    skillIds: parseIds(skillIdsText),
    mcpServerIds: parseIds(mcpServerIdsText),
  }), [draft, mcpServerIdsText, skillIdsText]);
  const dirty = !sameProfile(prepared, baseline);
  const changedProfile = !!profile && revision !== null && profile.revision !== revision;
  const conflict = changedProfile && dirty;

  useEffect(() => {
    if (!profile || dirty || submitting.current) return;
    const latest = profileInputFromProfile(profile);
    setDraft(latest);
    setBaseline(latest);
    setSkillIdsText(latest.skillIds.join(", "));
    setMcpServerIdsText(latest.mcpServerIds.join(", "));
    setRevision(profile.revision);
  }, [dirty, profile]);

  useEffect(() => {
    try {
      writeConfigDraft(
        draftKey,
        dirty
          ? { draft, baseline, skillIdsText, mcpServerIdsText, revision }
          : null,
      );
    } catch {
      setError("Draft could not be saved on this device. Save your changes before leaving.");
    }
  }, [baseline, draft, draftKey, dirty, mcpServerIdsText, revision, skillIdsText]);

  useEffect(() => {
    if (draft.modelMode !== "level") { setLevelPreview(null); return; }
    let current = true;
    void rpc.call("modelLevelPreview", { level: draft.level })
      .then((result) => { if (current) setLevelPreview(result); })
      .catch(() => { if (current) setLevelPreview(null); });
    return () => { current = false; };
  }, [draft.level, draft.modelMode, rpc]);
  useEffect(() => {
    let current = true;
    void rpc.call("models", { providerId: "hempi" })
      .then((models) => { if (current) setPiModels(models.filter(({ model }) => /^openai-codex\/gpt-[a-z0-9.-]+$/u.test(model) || model.startsWith("model-gateway/"))); })
      .catch(() => { if (current) setPiModels([]); });
    return () => { current = false; };
  }, [rpc]);

  useEffect(() => {
    let current = true;
    void sdk.projects.list()
      .then((projects) => { if (current) setProjects(projects); })
      .catch((cause) => { if (current) setError(message(cause)); });
    return () => {
      current = false;
    };
  }, [sdk]);
  useEffect(() => {
    if (!profile) return;
    let current = true;
    void rpc.call("agentDetail", { id: profile.id })
      .then(({ runsInLocked }) => { if (current) setRunsInLocked(runsInLocked); })
      .catch(() => { if (current) setRunsInLocked(true); });
    return () => { current = false; };
  }, [profile?.id, rpc]);

  const set = <Key extends keyof ProfileInput>(key: Key, value: ProfileInput[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || pending || conflict || !dirty) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await rpc.call("saveProfile", {
        ...prepared,
        ...(revision === null ? {} : { expectedRevision: revision }),
      });
      const savedProfile = profileInputFromProfile(result);
      setDraft(savedProfile);
      setBaseline(savedProfile);
      setSkillIdsText(savedProfile.skillIds.join(", "));
      setMcpServerIdsText(savedProfile.mcpServerIds.join(", "));
      setRevision(result.revision);
      setSaved(true);
      writeConfigDraft(draftKey, null);
      await onSaved(result);
    } catch (cause) {
      setError(message(cause));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };


  const loadLatest = () => {
    if (!profile) return;
    const latest = profileInputFromProfile(profile);
    setDraft(latest);
    setBaseline(latest);
    setSkillIdsText(latest.skillIds.join(", "));
    setMcpServerIdsText(latest.mcpServerIds.join(", "));
    setRevision(profile.revision);
    setError(null);
  };

  return (
    <form onSubmit={submit} className="bot-config-form" aria-label={profile ? "Agent profile" : "Create agent"}>
      <fieldset disabled={pending} className="min-w-0 space-y-5 border-0 p-0">
        <ConfigSection title="Identity">
          <ConfigRow label="Type" htmlFor={`${id}-kind`}>
            <div className="space-y-1.5">
              <select
                id={`${id}-kind`}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                value={draft.kind}
                onChange={(event) => set("kind", event.target.value as ProfileInput["kind"])}
              >
                <option value="full">Full: mission, memory and schedule</option>
                <option value="thin">Thin: fast, no mission</option>
              </select>
              {draft.kind === "thin" && baseline.kind === "full" ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  Mission and memory files remain on disk unused; switching back to Full reuses them.
                </p>
              ) : null}
            </div>
          </ConfigRow>
          <ConfigRow label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              aria-label="Agent name"
              required
              maxLength={80}
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </ConfigRow>
          <ConfigRow label="Mention" htmlFor={`${id}-slug`} hint="Lowercase letters, numbers, and hyphens. This becomes the @mention handle.">
            <Input
              id={`${id}-slug`}
              aria-label="Agent mention"
              required
              maxLength={60}
              value={draft.slug}
              onChange={(event) => set("slug", event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            />
          </ConfigRow>
          <ConfigRow label="Avatar" htmlFor={`${id}-avatar`}>
            <Input
              id={`${id}-avatar`}
              aria-label="Avatar"
              className="w-20 text-center"
              maxLength={16}
              value={draft.avatar}
              onChange={(event) => set("avatar", event.target.value)}
            />
          </ConfigRow>
          <ConfigRow label="Description" htmlFor={`${id}-description`}>
            <Input
              id={`${id}-description`}
              aria-label="Agent description"
              maxLength={240}
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
              placeholder="What this agent is responsible for"
            />
          </ConfigRow>
        </ConfigSection>

        <ConfigSection title="Execution">
          <p className="text-xs text-muted-foreground">Agents run through Pi with shared long memory and full permission.</p>
          <ConfigRow label="Default project" htmlFor={`${id}-run-project`}>
            <div className="space-y-1.5">
              <select
                id={`${id}-run-project`}
                disabled={runsInLocked}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                value={draft.runProjectId ?? ""}
                onChange={(event) => set("runProjectId", event.target.value || null)}
              >
                <option value="">Task&apos;s project</option>
                {draft.runProjectId && !projects.some((project) => project.id === draft.runProjectId) ? (
                  <option value={draft.runProjectId} disabled>Unavailable project</option>
                ) : null}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <p className="text-xs leading-5 text-muted-foreground">
                Used only when a task has no explicit project or environment. Existing DMs keep their current environment.
              </p>
              {runsInLocked ? <p className="text-xs text-muted-foreground">Default project is locked after the permanent DM is reserved. Explicit task context can still override it.</p> : null}
            </div>
          </ConfigRow>
          {draft.runProjectId ? (
            <ConfigRow label="Project checkout" hint="Work in the project's own checkout instead of a new worktree for each thread.">
              <Switch disabled={runsInLocked} checked={draft.runInCheckout} onCheckedChange={(checked) => set("runInCheckout", checked)} />
            </ConfigRow>
          ) : null}
          {draft.modelMode === "level" ? (
            <ConfigRow label="Level" hint="The level chooses the Codex model tier and effort.">
              <div className="space-y-2">
                <div
                  role="radiogroup"
                  aria-label="Agent model level"
                  className="grid overflow-hidden rounded-md border border-border sm:grid-cols-5"
                >
                  {[...modelLevels].reverse().map((level, index) => (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      aria-checked={draft.level === level}
                      className={`min-h-9 px-2 py-1.5 text-xs font-medium transition-colors hover:bg-state-hover ${
                        index ? "border-t border-border sm:border-l sm:border-t-0" : ""
                      } ${draft.level === level ? "bg-state-active text-foreground" : "text-muted-foreground"}`}
                      onClick={() => set("level", level)}
                    >
                      {modelLevelLabel(level)}
                    </button>
                  ))}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {levelPreview
                    ? `Codex: ${levelPreview.codex.displayName} · ${levelPreview.codex.reasoningLevel}`
                    : "Resolving current Codex model…"}
                </p>
              </div>
            </ConfigRow>
          ) : null}
          <ConfigRow label="Pin exact model" hint="Use an available Codex or Model Gateway model and effort instead of a level.">
            <Switch aria-label="Pin exact model" checked={draft.modelMode === "pinned"} onCheckedChange={(checked) => set("modelMode", checked ? "pinned" : "level")} />
          </ConfigRow>
          {draft.modelMode === "pinned" ? (
            <>
              <ConfigRow label="Route">
                <select aria-label="Model route" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.providerId === "model-gateway" ? "model-gateway" : "hempi"}
                  onChange={(event) => setDraft((current) => ({ ...current, providerId: event.target.value, model: event.target.value === "model-gateway"
                    ? current.model.replace(/^openai-codex\//u, "model-gateway/") : current.model.replace(/^model-gateway\//u, "openai-codex/") }))}>
                  <option value="hempi">Codex</option><option value="model-gateway">Model Gateway</option>
                </select>
              </ConfigRow>
              <ConfigRow label="Model">
                <select aria-label="Pinned model" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.model}
                  onChange={(event) => set("model", event.target.value)}>
                  {!piModels.some(({ model }) => draft.model === (draft.providerId === "model-gateway" ? model.replace(/^openai-codex\//u, "model-gateway/") : model)) && <option value={draft.model} disabled>Unsupported saved pin: {draft.model}</option>}
                  {piModels.filter(({ model }) => draft.providerId === "model-gateway" || model.startsWith("openai-codex/")).map(({ model, displayName }) => {
                    const value = draft.providerId === "model-gateway" ? model.replace(/^openai-codex\//u, "model-gateway/") : model;
                    return <option key={value} value={value}>{displayName}</option>;
                  })}
                </select>
              </ConfigRow>
              <ConfigRow label="Reasoning">
                <select aria-label="Pinned reasoning" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.reasoningLevel}
                  onChange={(event) => set("reasoningLevel", event.target.value as ProfileInput["reasoningLevel"])}>
                  {(piModels.find(({ model }) => draft.model === (draft.providerId === "model-gateway" ? model.replace(/^openai-codex\//u, "model-gateway/") : model))?.reasoningLevels ?? []).map((effort) =>
                    <option key={effort} value={effort}>{effort}</option>)}
                </select>
              </ConfigRow>
            </>
          ) : null}
          <ConfigRow label="Permissions" hint="Pi uses full permission.">
            <p className="text-sm text-foreground">Full access</p>
          </ConfigRow>
          <ConfigRow label="Fast service tier" hint="Use accelerated inference when the provider supports it.">
            <Switch
              checked={draft.serviceTier === "fast"}
              onCheckedChange={(checked) => set("serviceTier", checked ? "fast" : "default")}
            />
          </ConfigRow>
          <ConfigRow label="Show in sidebar" hint="List this agent under Bots. Hidden agents still answer mentions and plugin calls.">
            <Switch checked={draft.showInSidebar} onCheckedChange={(checked) => set("showInSidebar", checked)} />
          </ConfigRow>
          <ConfigRow label="Default agent" hint="Apply this persona to ordinary new threads.">
            <Switch checked={draft.isDefault} onCheckedChange={(checked) => set("isDefault", checked)} />
          </ConfigRow>
        </ConfigSection>

        <ConfigSection title="Instructions and tools">
          {profile?.kind === "full" && baseline.kind === "full" ? (
            <ConfigRow label="Persona">
              <p className="text-sm leading-5 text-muted-foreground">
                Edit this agent’s persona in the Persona tab. The agent can update it too.
              </p>
            </ConfigRow>
          ) : (
          <ConfigRow label="Custom instructions" htmlFor={`${id}-instructions`}>
            <Textarea
              id={`${id}-instructions`}
              aria-label="Custom instructions"
              className="min-h-36 resize-y leading-relaxed"
              maxLength={32_000}
              value={draft.instructions}
              onChange={(event) => set("instructions", event.target.value)}
              placeholder="Describe how this agent should approach its work."
            />
          </ConfigRow>
          )}
          <ConfigRow label="Skill IDs" htmlFor={`${id}-skills`} hint="Comma-separated skill IDs added to this agent.">
            <Input
              id={`${id}-skills`}
              value={skillIdsText}
              onChange={(event) => {
                setSkillIdsText(event.target.value);
                setSaved(false);
              }}
              placeholder="my-skill, another-skill"
            />
          </ConfigRow>
          <ConfigRow label="MCP server IDs" htmlFor={`${id}-mcp`} hint="Comma-separated MCP server IDs added to this agent.">
            <Input
              id={`${id}-mcp`}
              value={mcpServerIdsText}
              onChange={(event) => {
                setMcpServerIdsText(event.target.value);
                setSaved(false);
              }}
              placeholder="github, linear"
            />
          </ConfigRow>
        </ConfigSection>
      </fieldset>

      <ErrorMessage error={error} />
      {conflict ? (
        <div role="alert" className="text-sm text-muted-foreground">
          This profile changed elsewhere. Your draft is saved on this device.{" "}
          <Button type="button" variant="ghost" size="sm" onClick={loadLatest}>
            Discard draft and load latest
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-8 flex-wrap items-center justify-end gap-2">
        <span role="status" className="mr-auto text-xs text-muted-foreground">
          {pending ? "Saving…" : dirty && profile ? "Unsaved changes · draft saved" : saved ? "Saved" : ""}
        </span>
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
        ) : null}
        <Button
          size="sm"
          disabled={pending || conflict || !dirty || !prepared.name || !prepared.slug ||
            (prepared.modelMode === "pinned" && !piModels.some(({ model, reasoningLevels }) =>
              prepared.model === (prepared.providerId === "model-gateway" ? model.replace(/^openai-codex\//u, "model-gateway/") : model)
              && reasoningLevels.includes(prepared.reasoningLevel)))}
        >
          {pending ? "Saving…" : profile ? "Save profile" : "Create agent"}
        </Button>
      </div>
    </form>
  );
}
