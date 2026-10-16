// Create or edit one endpoint. The server validates the whole config again,
// so this form only shapes input and shows the server's message on failure.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { ResourceActionButton, ResourceDetailConfigurationSection, ResourceDetailPage, ResourceDetailStack } from "@/components/ui/resource-list";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { EndpointView, FieldSpec } from "../contract.js";
import { useWebhooksRpc } from "./data.js";
import { SLACK_PRESETS, configFromDraft, draftFromEndpoint, emptyField, newDraft, withSlackPreset, type Draft, type FieldDraft } from "./draft.js";
import { SecretReveal } from "./SecretReveal.js";
import { Choice, Field, Notice, WEBHOOK_ICON, messageOf, type ChoiceOption } from "./ui.js";

type Targets = {
  projects: { id: string; name: string }[];
  automations: { available: boolean; items: { id: string; name: string }[]; message: string | null };
  receivers: { pluginId: string; name: string; description: string | null }[];
};
const fieldTypes: ChoiceOption[] = (["string", "integer", "number", "boolean"] satisfies FieldSpec["type"][]).map((type) => ({ value: type, label: type }));
// Name, JSON path, type, required, remove. The header row and every field row share it.
const fieldGrid = "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_7rem_5.5rem_1.5rem]";

function useTargets(projectId: string) {
  const rpc = useWebhooksRpc();
  const [targets, setTargets] = useState<Targets | null>(null);
  useEffect(() => {
    let live = true;
    const id = projectId.trim();
    rpc.call("webhooks_targets", id ? { projectId: id } : {}).then(
      (value) => live && setTargets(value),
      () => live && setTargets(null),
    );
    return () => {
      live = false;
    };
  }, [rpc, projectId]);
  return targets;
}

export function EndpointForm({ endpoint, onSaved, onCancel }: { endpoint?: EndpointView; onSaved: (endpointId: string) => void; onCancel: () => void }) {
  const rpc = useWebhooksRpc();
  const [draft, setDraft] = useState<Draft>(() => (endpoint ? draftFromEndpoint(endpoint) : newDraft()));
  const [importedSecret, setImportedSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<{ endpointId: string; secret: string } | null>(null);
  const targets = useTargets(draft.actionType === "spawn" || draft.actionType === "automation" ? draft.projectId : "");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setField = (index: number, patch: Partial<FieldDraft>) =>
    setDraft((current) => ({ ...current, fields: current.fields.map((field, at) => (at === index ? { ...field, ...patch } : field)) }));

  if (issued) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <SecretReveal secret={issued.secret} authMode={draft.authMode} onDone={() => onSaved(issued.endpointId)} />
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const config = configFromDraft(draft);
      const secret = showSecretInput && importedSecret.trim() ? { secret: importedSecret.trim() } : {};
      const result = endpoint ? await rpc.call("webhooks_update", { endpointId: endpoint.id, config, ...secret }) : await rpc.call("webhooks_create", { config, ...secret });
      if (result.secret) setIssued({ endpointId: result.endpoint.id, secret: result.secret });
      else onSaved(result.endpoint.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  };

  const authChanged = endpoint !== undefined && endpoint.authMode !== draft.authMode;
  const slack = draft.authMode === "slack";
  // Edits keep the secret unless the mode changes. Slack secrets come from Slack, never from us.
  const showSecretInput = endpoint === undefined || authChanged;
  const placeholders = ["fields", "endpoint_name", "delivery_id", "received_at", ...draft.fields.map((field) => field.name).filter(Boolean)];
  const fieldNames = draft.fields.map((field) => field.name.trim()).filter(Boolean);

  return (
    <ResourceDetailPage
      leading={<Icon name={WEBHOOK_ICON} aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
      title={endpoint ? "Edit endpoint" : "New endpoint"}
      metadata={endpoint?.name}
    >
      <form onSubmit={submit} aria-label={endpoint ? "Edit endpoint" : "New endpoint"} className="flex flex-col gap-6">
        <ResourceDetailStack>
          <ResourceDetailConfigurationSection label="Endpoint">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">{(control) => <Input {...control} value={draft.name} onChange={(event) => set("name", event.target.value)} maxLength={80} required />}</Field>
              <Field
                label="Authentication"
                hint={authChanged ? (slack ? "Saving uses the signing secret below." : "Saving issues a new secret.") : undefined}
              >
                {(control) => (
                  <Choice
                    {...control}
                    value={draft.authMode}
                    onChange={(value) => setDraft((current) => withAuthMode(current, value as Draft["authMode"]))}
                    options={[
                      { value: "standard-webhooks", label: "Standard Webhooks (PostHog)" },
                      { value: "slack", label: "Slack" },
                      { value: "bearer", label: "Bearer token" },
                    ]}
                  />
                )}
              </Field>
              {!showSecretInput ? null : slack ? (
                <Field label="Slack signing secret" hint="Basic Information → App Credentials. Not the bot token." className="sm:col-span-2">
                  {(control) => <Input {...control} type="password" autoComplete="off" value={importedSecret} onChange={(event) => setImportedSecret(event.target.value)} required />}
                </Field>
              ) : (
                <Field
                  label="Existing secret (optional)"
                  hint="Leave empty to generate one."
                  className="sm:col-span-2"
                >
                  {(control) => <Input {...control} type="password" autoComplete="off" value={importedSecret} onChange={(event) => setImportedSecret(event.target.value)} />}
                </Field>
              )}
              {slack ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
                  <span>Presets:</span>
                  {(Object.keys(SLACK_PRESETS) as (keyof typeof SLACK_PRESETS)[]).map((kind) => (
                    <Button key={kind} type="button" variant="outline" size="sm" onClick={() => setDraft((current) => withSlackPreset(current, kind))}>
                      {SLACK_PRESETS[kind].label}
                    </Button>
                  ))}
                </div>
              ) : null}
              <Field label="Max body bytes" hint="1024 to 1048576.">
                {(control) => <Input {...control} inputMode="numeric" value={draft.maxBodyBytes} onChange={(event) => set("maxBodyBytes", event.target.value)} />}
              </Field>
              <Field label="Deliveries per minute" hint="1 to 600.">
                {(control) => <Input {...control} inputMode="numeric" value={draft.rateLimitPerMinute} onChange={(event) => set("rateLimitPerMinute", event.target.value)} />}
              </Field>
              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground sm:col-span-2">
                <Switch checked={draft.enabled} onCheckedChange={(enabled) => set("enabled", enabled)} />
                Enabled
              </label>
            </div>
          </ResourceDetailConfigurationSection>

          <ResourceDetailConfigurationSection
            label="Payload fields"
            actions={
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => set("fields", [...draft.fields, emptyField()])}>
                <Icon name="Plus" aria-hidden className="size-3.5" />
                Add field
              </Button>
            }
          >
            <SectionHint>Only these fields reach the action.</SectionHint>
            {draft.fields.length === 0 ? (
              <p className="text-sm text-muted-foreground">No fields.</p>
            ) : (
              <div className="flex flex-col">
                <div aria-hidden className={`hidden gap-2 pb-1.5 text-xs font-medium text-muted-foreground sm:grid ${fieldGrid}`}>
                  <span>Name</span>
                  <span>JSON path</span>
                  <span>Type</span>
                </div>
                <div className="divide-y divide-border/60">
                  {draft.fields.map((field, index) => (
                    <FieldRow
                      key={index}
                      index={index}
                      field={field}
                      onChange={(patch) => setField(index, patch)}
                      onRemove={() => setDraft((current) => ({ ...current, fields: current.fields.filter((_, at) => at !== index) }))}
                    />
                  ))}
                </div>
              </div>
            )}
          </ResourceDetailConfigurationSection>

          <ResourceDetailConfigurationSection label="Duplicates">
            <SectionHint>Repeats are accepted and skipped.</SectionHint>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Duplicate key">
                {(control) => (
                  <Choice
                    {...control}
                    value={draft.dedupeSource}
                    onChange={(value) => set("dedupeSource", value as Draft["dedupeSource"])}
                    options={[
                      { value: "webhook-id", label: "webhook-id header", disabled: draft.authMode !== "standard-webhooks" },
                      { value: "field", label: "Payload field" },
                      { value: "body-hash", label: "Body hash" },
                    ]}
                  />
                )}
              </Field>
              {draft.dedupeSource === "field" ? (
                <Field label="Field" hint="Required string or integer.">
                  {(control) => (
                    <Choice
                      {...control}
                      value={draft.dedupeField}
                      placeholder="Choose a field"
                      onChange={(value) => set("dedupeField", value)}
                      options={withCurrent(draft.dedupeField, fieldNames.map((name) => ({ value: name, label: name })))}
                    />
                  )}
                </Field>
              ) : null}
            </div>
          </ResourceDetailConfigurationSection>

          <ResourceDetailConfigurationSection label="Action">
            <SectionHint>Payload values can fill the message, never the target.</SectionHint>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Do" className="sm:col-span-2">
                {(control) => (
                  <Choice
                    {...control}
                    value={draft.actionType}
                    onChange={(value) => set("actionType", value as Draft["actionType"])}
                    options={[
                      { value: "send", label: "Send to a thread" },
                      { value: "spawn", label: "Start a thread" },
                      { value: "automation", label: "Run an automation" },
                      { value: "plugin", label: "Hand to a plugin" },
                    ]}
                  />
                )}
              </Field>
              {draft.actionType === "send" ? (
                <Field
                  label="Thread id"
                >
                  {(control) => <Input {...control} value={draft.threadId} placeholder="thr_…" onChange={(event) => set("threadId", event.target.value)} />}
                </Field>
              ) : draft.actionType === "plugin" ? (
                <ReceiverPicker value={draft.pluginId} targets={targets} onChange={(value) => set("pluginId", value)} />
              ) : (
                <ProjectPicker value={draft.projectId} targets={targets} onChange={(value) => set("projectId", value)} />
              )}
              {draft.actionType === "automation" ? <AutomationPicker value={draft.automationId} targets={targets} onChange={(value) => set("automationId", value)} /> : null}
              {draft.actionType === "spawn" ? (
                <Field label="Thread title (optional)">
                  {(control) => <Input {...control} value={draft.title} maxLength={200} onChange={(event) => set("title", event.target.value)} />}
                </Field>
              ) : null}
              {draft.actionType === "spawn" ? <EnvironmentFields draft={draft} set={set} /> : null}
              {draft.actionType === "automation" ? (
                <Notice tone="warning" className="sm:col-span-2">
                  Runs the saved prompt. Payload fields are not passed in.
                </Notice>
              ) : draft.actionType === "plugin" ? (
                <p className="text-xs leading-snug text-muted-foreground sm:col-span-2">The plugin gets the declared field values and decides what to do. No message is sent.</p>
              ) : (
                <Field
                  label="Message"
                  className="sm:col-span-2"
                  hint={
                    <>
                      Placeholders: <span className="font-mono">{placeholders.map((name) => `{{${name}}}`).join(" ")}</span>
                    </>
                  }
                >
                  {(control) => (
                    <Textarea {...control} rows={5} className="font-mono text-xs" value={draft.message} maxLength={8000} onChange={(event) => set("message", event.target.value)} />
                  )}
                </Field>
              )}
            </div>
          </ResourceDetailConfigurationSection>
        </ResourceDetailStack>

        {error === null ? null : (
          <Notice tone="error">
            <pre className="whitespace-pre-wrap font-sans">{error}</pre>
          </Notice>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border/80 pt-4">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {endpoint ? "Save" : "Create endpoint"}
          </Button>
        </div>
      </form>
    </ResourceDetailPage>
  );
}

/** Only Standard Webhooks senders send a webhook-id header, so other modes move that key to the body hash. */
function withAuthMode(draft: Draft, authMode: Draft["authMode"]): Draft {
  const dedupeSource = authMode !== "standard-webhooks" && draft.dedupeSource === "webhook-id" ? "body-hash" : draft.dedupeSource;
  return { ...draft, authMode, dedupeSource };
}

/** Keeps a saved value selectable when the target list no longer has it. */
function withCurrent(value: string, options: ChoiceOption[]): ChoiceOption[] {
  return value && !options.some((option) => option.value === value) ? [{ value, label: value }, ...options] : options;
}

function SectionHint({ children }: { children: ReactNode }) {
  return <p className="-mt-1 text-xs leading-snug text-muted-foreground">{children}</p>;
}

function FieldRow({ index, field, onChange, onRemove }: { index: number; field: FieldDraft; onChange: (patch: Partial<FieldDraft>) => void; onRemove: () => void }) {
  const n = index + 1;
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 py-2.5 first:pt-0 last:pb-0 ${fieldGrid}`}>
      <Input aria-label={`Field ${n} name`} value={field.name} placeholder="event" className="col-span-3 sm:col-span-1" onChange={(event) => onChange({ name: event.target.value })} />
      <Input
        aria-label={`Field ${n} path`}
        value={field.path}
        placeholder="event.name"
        className="col-span-3 font-mono text-xs sm:col-span-1"
        onChange={(event) => onChange({ path: event.target.value })}
      />
      <Choice aria-label={`Field ${n} type`} value={field.type} options={fieldTypes} onChange={(value) => onChange({ type: value as FieldSpec["type"] })} />
      <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
        <Checkbox aria-label={`Field ${n} required`} checked={field.required} onCheckedChange={(checked) => onChange({ required: checked === true })} />
        Required
      </label>
      <ResourceActionButton label={`Remove field ${n}`} icon="Trash2" className="justify-self-end" onClick={onRemove} />
      {field.type === "string" ? (
        <div className="col-span-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground sm:col-span-5">
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0 sm:w-auto">Max length</span>
            <Input
              aria-label={`Field ${n} max length`}
              inputMode="numeric"
              placeholder="500"
              className="h-8 w-20"
              value={field.maxLength}
              onChange={(event) => onChange({ maxLength: event.target.value })}
            />
          </label>
          <label className="flex min-w-48 flex-1 items-center gap-2">
            <span className="w-24 shrink-0 sm:w-auto">Allowed values</span>
            <Input
              aria-label={`Field ${n} allowed values`}
              placeholder="Any. Comma separated."
              className="h-8 flex-1"
              value={field.allowed}
              onChange={(event) => onChange({ allowed: event.target.value })}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function ProjectPicker({ value, targets, onChange }: { value: string; targets: Targets | null; onChange: (value: string) => void }) {
  const known = targets?.projects ?? [];
  if (known.length === 0) {
    return <Field label="Project id">{(control) => <Input {...control} value={value} onChange={(event) => onChange(event.target.value)} />}</Field>;
  }
  return (
    <Field label="Project">
      {(control) => (
        <Choice {...control} value={value} placeholder="Choose a project" onChange={onChange} options={withCurrent(value, known.map((project) => ({ value: project.id, label: project.name })))} />
      )}
    </Field>
  );
}

function AutomationPicker({ value, targets, onChange }: { value: string; targets: Targets | null; onChange: (value: string) => void }) {
  const automations = targets?.automations;
  if (!automations?.available) {
    return (
      <Field label="Automation id" hint={automations?.message ?? "Choose a project first."}>
        {(control) => <Input {...control} value={value} onChange={(event) => onChange(event.target.value)} />}
      </Field>
    );
  }
  return (
    <Field label="Automation" hint={automations.items.length === 0 ? "No automations in this project." : undefined}>
      {(control) => (
        <Choice
          {...control}
          value={value}
          placeholder="Choose an automation"
          onChange={onChange}
          options={withCurrent(value, automations.items.map((item) => ({ value: item.id, label: item.name })))}
        />
      )}
    </Field>
  );
}

function ReceiverPicker({ value, targets, onChange }: { value: string; targets: Targets | null; onChange: (value: string) => void }) {
  const receivers = targets?.receivers ?? [];
  if (receivers.length === 0) {
    return (
      <Field label="Plugin id" hint="No installed plugin accepts webhook deliveries.">
        {(control) => <Input {...control} value={value} onChange={(event) => onChange(event.target.value)} />}
      </Field>
    );
  }
  const chosen = receivers.find((receiver) => receiver.pluginId === value);
  return (
    <Field label="Plugin" hint={chosen?.description ?? undefined}>
      {(control) => (
        <Choice
          {...control}
          value={value}
          placeholder="Choose a plugin"
          onChange={onChange}
          options={withCurrent(value, receivers.map((receiver) => ({ value: receiver.pluginId, label: receiver.name })))}
        />
      )}
    </Field>
  );
}

function EnvironmentFields({ draft, set }: { draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void }) {
  return (
    <>
      <Field label="Environment">
        {(control) => (
          <Choice
            {...control}
            value={draft.environmentType}
            onChange={(value) => set("environmentType", value as Draft["environmentType"])}
            options={[
              { value: "project-default", label: "Project default" },
              { value: "reuse", label: "Reuse an environment" },
              { value: "worktree", label: "New managed worktree" },
              { value: "provider", label: "Environment provider" },
            ]}
          />
        )}
      </Field>
      {draft.environmentType === "reuse" ? (
        <Field label="Environment id">{(control) => <Input {...control} value={draft.environmentId} onChange={(event) => set("environmentId", event.target.value)} />}</Field>
      ) : null}
      {draft.environmentType === "worktree" ? (
        <>
          <Field label="Host id (optional)">{(control) => <Input {...control} value={draft.hostId} onChange={(event) => set("hostId", event.target.value)} />}</Field>
          <Field label="Base branch (optional)" hint="Empty uses the default.">
            {(control) => <Input {...control} value={draft.baseBranch} onChange={(event) => set("baseBranch", event.target.value)} />}
          </Field>
        </>
      ) : null}
      {draft.environmentType === "provider" ? (
        <>
          <Field label="Environment provider id">
            {(control) => <Input {...control} value={draft.environmentProviderId} onChange={(event) => set("environmentProviderId", event.target.value)} />}
          </Field>
          <Field label="Provider inputs (JSON)" hint="Fixed values." className="sm:col-span-2">
            {(control) => <Textarea {...control} rows={3} className="font-mono text-xs" value={draft.providerInputs} onChange={(event) => set("providerInputs", event.target.value)} />}
          </Field>
        </>
      ) : null}
    </>
  );
}
