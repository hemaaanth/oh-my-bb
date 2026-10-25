import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  definePluginApp,
  useBbContext,
  useRealtime,
  useRpc,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyStatePanel } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import "./app.css";

type Scope = { type: "global" | "project" | "environment"; id: string };
type ScopeOption = Scope & { label: string; parentId: string | null };
type Topic = "design" | "copy" | "engineering" | "workflow";
type ContextRecord = {
  id: string; logicalKey: string; kind: "fact" | "preference";
  value: string; priority: number; updatedAt: number; scope: ScopeOption;
  topic: Topic; sourceThreadId: string | null; consentRef: string | null; unconsented: boolean;
};
type NapkinRecord = {
  id: string; logicalKey: string; category: string; priority: number;
  recurrence: number; hitCount: number; situation: string; action: string; updatedAt: number;
  scope: ScopeOption; sourceThreadId: string | null;
};
type PapercutRecord = {
  id: string; fingerprint: string; summary: string; severity: "minor" | "major" | "blocker";
  prevention: string; acceptanceCondition: string; lifecycle: "open" | "resolved" | "dismissed";
  recurrence: number; updatedAt: number; scope: ScopeOption;
};
type Dashboard = {
  scopes: ScopeOption[];
  selectedScope: ScopeOption | null;
  currentEnvironmentId: string | null;
  context: ContextRecord[];
  napkins: NapkinRecord[];
  papercuts: PapercutRecord[];
};
type View = "review" | "guidance" | "history";
type RecordType = "context" | "napkin" | "papercut";


function ClasiPanel() {
  const { projectId, threadId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Dashboard | null>(null);
  const [view, setView] = useState<View>("review");
  const [draftType, setDraftType] = useState<RecordType>("context");
  const [showComposer, setShowComposer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(emptyForm());
  const loadSequence = useRef(0);

  const load = useCallback(async (scope: Scope | null = data?.selectedScope ?? null) => {
    const sequence = ++loadSequence.current;
    try {
      setError(null);
      const requestedScope = scope ? { type: scope.type, id: scope.id } : null;
      const result = await rpc.call("dashboard", { projectId, threadId, scope: requestedScope });
      if (sequence === loadSequence.current) setData(result as Dashboard);
    } catch (cause) {
      if (sequence === loadSequence.current) setError(message(cause));
    }
  }, [data?.selectedScope, projectId, rpc, threadId]);

  useEffect(() => { void load(null); }, [projectId, threadId]);
  useRealtime("changed", () => { void load(); });

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!data?.selectedScope) return;
    const scope = { type: data.selectedScope.type, id: data.selectedScope.id };
    void mutate(async () => {
      if (draftType === "context") {
        await rpc.call("saveContext", {
          scope,
          logicalKey: form.key,
          kind: form.kind as "fact" | "preference",
          value: form.value,
          priority: Number(form.priority),
          topic: form.topic as Topic,
        });
      } else if (draftType === "napkin") {
        await rpc.call("saveNapkin", {
          scope,
          logicalKey: form.key,
          category: form.category as "Execution" | "Validation" | "Tooling" | "Repository Conventions" | "Domain Guardrails" | "Design" | "Copy",
          situation: form.situation,
          action: form.action,
          priority: Number(form.priority),
        });
      } else {
        await rpc.call("savePapercut", {
          scope,
          fingerprint: form.key,
          summary: form.summary,
          severity: form.severity as "minor" | "major" | "blocker",
          prevention: form.prevention,
          acceptanceCondition: form.acceptance,
        });
      }
      setForm(emptyForm());
      setShowComposer(false);
      setView(draftType === "papercut" ? "review" : "guidance");
    });
  };

  const openPapercuts = data?.papercuts.filter((item) => item.lifecycle === "open") ?? [];
  const closedPapercuts = data?.papercuts.filter((item) => item.lifecycle !== "open") ?? [];
  const scopeOptions = data ? relevantScopes(data) : [];

  return (
    <TooltipProvider delayDuration={300}>
    <ScrollArea className="clasi-page h-full min-h-0 bg-background text-foreground">
      <main className="mx-auto w-full max-w-[760px] space-y-5 px-4 py-6">
        <PageIntro view={view} />
        <div className="clasi-toolbar flex items-center justify-between gap-2">
        <div className="inline-flex min-w-0 items-center gap-0.5 rounded-md bg-surface-recessed p-0.5" role="group" aria-label="Clasi view">
          {(["review", "guidance", "history"] as const).map((value) => (
            <Button
              className="h-7 px-2 data-[state=active]:shadow-xs"
              data-state={view === value ? "active" : "inactive"}
              key={value}
              type="button"
              size="sm"
              variant={view === value ? "secondary" : "ghost"}
              aria-pressed={view === value}
              onClick={() => { setView(value); setShowComposer(false); }}
            >
              {viewLabel(value)}
              {value === "review" && openPapercuts.length > 0 && (
                <span className="tabular-nums text-muted-foreground">{openPapercuts.length}</span>
              )}
            </Button>
          ))}
        </div>
        <Button
          className="h-7 px-2"
          type="button"
          size="sm"
          variant={showComposer ? "secondary" : "outline"}
          aria-expanded={showComposer}
          disabled={!data?.selectedScope}
          onClick={() => setShowComposer((current) => !current)}
        >
          <Icon name={showComposer ? "X" : "Plus"} className="size-3.5" />
          <span>{showComposer ? "Cancel" : "Add"}</span>
        </Button>
      </div>

          {error && (
            <div role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {!data ? <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p> : <>

            {(data.currentEnvironmentId === null || scopeOptions.length > 1) && (
              <Field label="Scope">
                <Select
                  value={data.selectedScope ? scopeValue(data.selectedScope) : "all"}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (!value || (value !== "all" && !scopeOptions.some((scope) => scopeValue(scope) === value))) return;
                    const next = value === "all"
                      ? null
                      : scopeOptions.find((scope) => scopeValue(scope) === value) ?? null;
                    setShowComposer(false);
                    void load(next);
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {data.currentEnvironmentId === null && <SelectItem value="all">All scopes</SelectItem>}
                    {scopeOptions.map((scope) => (
                      <SelectItem key={scopeValue(scope)} value={scopeValue(scope)}>
                        {scope.type === "global"
                          ? "Everywhere"
                          : scope.type === "project"
                            ? `Repository · ${scope.label}`
                            : `Worktree · ${data.scopes.find((candidate) => candidate.type === "project" && candidate.id === scope.parentId)?.label ?? "Personal"} / ${scope.label}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                  {data.selectedScope ? scopeDescription(data.selectedScope) : "all captured records across this bb server"}
                </span>
              </Field>
            )}

            {showComposer && data.selectedScope && (
              <Composer
                type={draftType}
                setType={(type) => { setDraftType(type); setForm(emptyForm()); }}
                form={form}
                setForm={setForm}
                busy={busy}
                scope={data.selectedScope}
                onSubmit={submit}
              />
            )}

            {view === "review" && (
              <PapercutSection
                title="Needs attention"
                description="Open papercuts that need a decision or a fix."
                items={openPapercuts}
                empty={data.selectedScope ? "Nothing needs review in this scope." : "Nothing needs review in any scope."}
                busy={busy}
                onDelete={(id) => mutate(() => rpc.call("remove", { type: "papercut", id }))}
                onChange={(id, lifecycle) => mutate(() => rpc.call("updatePapercut", { id, lifecycle }))}
              />
            )}

            {view === "guidance" && (
              <Guidance
                data={data}
                busy={busy}
                onDelete={(type, id) => mutate(() => rpc.call("remove", { type, id }))}
                onHit={(id) => mutate(() => rpc.call("markHit", { id }))}
              />
            )}

            {view === "history" && (
              <PapercutSection
                title="History"
                description="Papercuts that were resolved or dismissed."
                items={closedPapercuts}
                empty={data.selectedScope ? "No resolved or dismissed papercuts in this scope." : "No resolved or dismissed papercuts in any scope."}
                busy={busy}
                onDelete={(id) => mutate(() => rpc.call("remove", { type: "papercut", id }))}
                onChange={(id, lifecycle) => mutate(() => rpc.call("updatePapercut", { id, lifecycle }))}
              />
            )}
          </>}
      </main>
    </ScrollArea>
    </TooltipProvider>
  );
}

function PageIntro({ view }: { view: View | "setup" }) {
  const navigate = useBbNavigate();
  const subtitle = view === "review"
    ? "Review workflow feedback that needs action."
    : view === "guidance"
      ? "Manage context and reusable lessons."
      : view === "history"
        ? "Review resolved and dismissed feedback."
        : "Scopes, retention, and optional integrations.";
  return <header className="flex items-center gap-3">
    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-recessed/70">
      <Icon name="clasi/brain" className="size-5" />
    </div>
    <div className="min-w-0 flex-1">
      <h1 className="text-base font-semibold">Clasi</h1>
      <p className="text-xs leading-4 text-muted-foreground">{subtitle}</p>
    </div>
    {view !== "setup" && <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={() => navigate.toPluginPanel("clasi", { subPath: "setup" })}>Guide</Button>}
  </header>;
}

function Composer({ type, setType, form, setForm, busy, scope, onSubmit }: {
  type: RecordType;
  setType: (type: RecordType) => void;
  form: Record<string, string>;
  setForm: FormProps["setForm"];
  busy: boolean;
  scope: ScopeOption;
  onSubmit: (event: FormEvent) => void;
}) {
  return <Card className="rounded-md bg-surface-recessed/70">
    <CardHeader className="p-3 pb-3">
      <CardTitle className="text-sm">Add to {scopeLabel(scope).toLowerCase()}</CardTitle>
      <p className="text-xs text-muted-foreground">Choose what the agent should do with this information.</p>
    </CardHeader>
    <CardContent className="p-3 pt-0">
      <div className="mb-4 inline-flex gap-1 rounded-md bg-background p-1" role="group" aria-label="New record type">
        {(["context", "napkin", "papercut"] as const).map((value) => (
          <Button
            className="h-7 px-2 data-[state=active]:shadow-xs"
            data-state={type === value ? "active" : "inactive"}
            key={value}
            type="button"
            size="sm"
            variant={type === value ? "secondary" : "ghost"}
            aria-pressed={type === value}
            onClick={() => setType(value)}
          >
            {recordTypeLabel(value)}
          </Button>
        ))}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{recordTypeDescription(type)}</p>
      <form className="clasi-form grid gap-3" onSubmit={onSubmit}>
        <Field label={type === "papercut" ? "Fingerprint" : "Logical key"}>
          <Input required maxLength={80} pattern="[a-z0-9]+([._-][a-z0-9]+)*" value={form.key} onChange={set("key", setForm)} />
        </Field>
        {type === "context" && <ContextFields form={form} setForm={setForm} />}
        {type === "napkin" && <NapkinFields form={form} setForm={setForm} />}
        {type === "papercut" && <PapercutFields form={form} setForm={setForm} />}
        <div className="clasi-wide"><Button type="submit" disabled={busy}>{busy ? "Saving…" : `Add ${recordTypeLabel(type).toLowerCase()}`}</Button></div>
      </form>
    </CardContent>
  </Card>;
}

function ContextFields({ form, setForm }: FormProps) {
  return <>
    <Field label="Kind"><Select value={form.kind} onValueChange={(value) => { if (value === "fact" || value === "preference") setForm((current) => ({ ...current, kind: value })); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="fact">Fact</SelectItem><SelectItem value="preference">Preference</SelectItem></SelectContent></Select></Field>
    <Field label="Topic"><Select value={form.topic} onValueChange={(value) => { if (TOPICS.includes(value as Topic)) setForm((current) => ({ ...current, topic: value })); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TOPICS.map((value) => <SelectItem key={value} value={value}>{topicLabel(value)}</SelectItem>)}</SelectContent></Select></Field>
    <Field className="clasi-wide" label="Value"><Text value={form.value} onChange={set("value", setForm)} /></Field>
    <Priority form={form} setForm={setForm} />
  </>;
}

function NapkinFields({ form, setForm }: FormProps) {
  return <>
    <Field label="Category"><Select value={form.category} onValueChange={(value) => { if (NAPKIN_CATEGORIES.includes(value)) setForm((current) => ({ ...current, category: value })); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{NAPKIN_CATEGORIES.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field>
    <Field className="clasi-wide" label="Situation"><Text value={form.situation} onChange={set("situation", setForm)} /></Field>
    <Field className="clasi-wide" label="Action"><Text value={form.action} onChange={set("action", setForm)} /></Field>
    <Priority form={form} setForm={setForm} />
  </>;
}

function PapercutFields({ form, setForm }: FormProps) {
  return <>
    <Field label="Severity"><Select value={form.severity} onValueChange={(value) => { if (["minor", "major", "blocker"].includes(value)) setForm((current) => ({ ...current, severity: value })); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="minor">Minor</SelectItem><SelectItem value="major">Major</SelectItem><SelectItem value="blocker">Blocker</SelectItem></SelectContent></Select></Field>
    <Field className="clasi-wide" label="Summary"><Text value={form.summary} onChange={set("summary", setForm)} /></Field>
    <Field className="clasi-wide" label="Prevention"><Text value={form.prevention} onChange={set("prevention", setForm)} /></Field>
    <Field className="clasi-wide" label="Acceptance condition"><Text value={form.acceptance} onChange={set("acceptance", setForm)} /></Field>
  </>;
}

function Priority({ form, setForm }: FormProps) {
  return <Field label="Priority (0–100)"><Input required type="number" min={0} max={100} value={form.priority} onChange={set("priority", setForm)} /></Field>;
}

function Text(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Textarea {...props} required rows={2} maxLength={240} className="min-h-20 resize-y bg-background" />;
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`grid gap-1.5 text-sm ${className}`}><span>{label}</span>{children}</label>;
}

function Guidance({ data, busy, onDelete, onHit }: {
  data: Dashboard;
  busy: boolean;
  onDelete: (type: "context" | "napkin", id: string) => void;
  onHit: (id: string) => void;
}) {
  const [topicFilter, setTopicFilter] = useState<"all" | Topic>("all");
  if (!data.context.length && !data.napkins.length) {
    return <EmptyStatePanel>{data.selectedScope ? "There is no active guidance in this scope." : "There is no active guidance in any scope."}</EmptyStatePanel>;
  }
  const visibleContext = topicFilter === "all"
    ? data.context
    : data.context.filter((item) => item.topic === topicFilter);
  return <div className="space-y-5">
    {data.context.length > 0 && <RecordSection
      title="Context"
      description="Facts and preferences that are already in effect."
      count={visibleContext.length}
      controls={<Select value={topicFilter} onValueChange={(value) => setTopicFilter(value as "all" | Topic)}>
        <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All topics</SelectItem>
          {TOPICS.map((value) => <SelectItem key={value} value={value}>{topicLabel(value)}</SelectItem>)}
        </SelectContent>
      </Select>}
    >
      {visibleContext.length === 0
        ? <div className="px-4 py-3 text-sm text-muted-foreground">No {topicFilter} context in view.</div>
        : visibleContext.map((item) => (
          <RecordRow
            key={item.id}
            title={item.logicalKey}
            body={item.value}
            meta={<>
              {item.kind} · <TopicBadge value={item.topic} /> · priority {item.priority} · {recordScopeLabel(item.scope)}
              {item.sourceThreadId ? <span className="text-muted-foreground/70"> · from thread {truncateId(item.sourceThreadId)}</span> : null}
              {item.unconsented && <>
                {" "}
                <span
                  className="rounded border border-border px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground"
                  title="Design/copy entry saved without a consent reference"
                >
                  unconsented
                </span>
              </>}
            </>}
            actions={<Delete label={item.logicalKey} disabled={busy} onClick={() => onDelete("context", item.id)} />}
          />
        ))}
    </RecordSection>}
    {data.napkins.length > 0 && <RecordSection
      title="Napkins"
      description="Reusable lessons that agents apply automatically."
      count={data.napkins.length}
    >
      {data.napkins.map((item) => (
        <RecordRow
          key={item.id}
          title={item.logicalKey}
          body={`When ${item.situation}; do ${item.action}`}
          meta={`${item.category} · reinforced ${item.recurrence}× · helpful ${item.hitCount}× · ${recordScopeLabel(item.scope)}`}
          actions={<><Button className="h-7 px-2" size="sm" variant="outline" disabled={busy} onClick={() => onHit(item.id)}>Helpful</Button><Delete label={item.logicalKey} disabled={busy} onClick={() => onDelete("napkin", item.id)} /></>}
        />
      ))}
    </RecordSection>}
  </div>;
}

function PapercutSection({ title, description, items, empty, busy, onDelete, onChange }: {
  title: string;
  description: string;
  items: PapercutRecord[];
  empty: string;
  busy: boolean;
  onDelete: (id: string) => void;
  onChange: (id: string, lifecycle: "open" | "resolved" | "dismissed") => void;
}) {
  if (!items.length) return <EmptyStatePanel>{empty}</EmptyStatePanel>;
  return <RecordSection title={title} description={description} count={items.length}>
    {items.map((item) => (
      <RecordRow
        key={item.id}
        title={item.summary}
        body={`Prevent it: ${item.prevention}`}
        meta={<><Severity value={item.severity} /> · {item.fingerprint} · seen {item.recurrence}× · {recordScopeLabel(item.scope)}{item.lifecycle !== "open" ? ` · ${item.lifecycle}` : ""}</>}
        actions={<>{item.lifecycle === "open" ? <>
          <ActionIcon icon="Check" label="Resolve" variant="default" disabled={busy} onClick={() => onChange(item.id, "resolved")} />
          <ActionIcon icon="X" label="Dismiss" disabled={busy} onClick={() => onChange(item.id, "dismissed")} />
        </> : <Button className="h-7 px-2" size="sm" variant="outline" disabled={busy} onClick={() => onChange(item.id, "open")}>Reopen</Button>}<Delete label={item.fingerprint} disabled={busy} onClick={() => onDelete(item.id)} /></>}
      />
    ))}
  </RecordSection>;
}

function RecordSection({ title, description, count, controls, children }: {
  title: string;
  description: string;
  count: number;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) {
  return <section className="space-y-2">
    <div className="clasi-section-heading flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {controls}
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      </div>
    </div>
    <div className="divide-y divide-border-hairline overflow-hidden rounded-md border border-border bg-surface-recessed/70">{children}</div>
  </section>;
}

function RecordRow({ title, body, meta, actions }: { title: string; body: string; meta: React.ReactNode; actions: React.ReactNode }) {
  return <div className="clasi-record flex items-start justify-between gap-3 p-3">
    <div className="min-w-0 flex-1">
      <div className="break-words text-sm font-medium">{title}</div>
      <p className="mt-1 break-words text-sm leading-5 text-muted-foreground">{body}</p>
      <details className="mt-1.5 text-xs text-muted-foreground"><summary className="cursor-pointer">Details</summary><Meta>{meta}</Meta></details>
    </div>
    <div className="clasi-record-actions flex shrink-0 items-center gap-1">{actions}</div>
  </div>;
}

function Severity({ value }: { value: PapercutRecord["severity"] }) {
  return <span className={value === "blocker" ? "font-medium text-destructive" : value === "major" ? "font-medium text-foreground" : ""}>{value}</span>;
}

const NAPKIN_CATEGORIES = ["Execution", "Validation", "Tooling", "Repository Conventions", "Domain Guardrails", "Design", "Copy"];
const TOPICS = ["engineering", "workflow", "design", "copy"] as const;
function topicLabel(topic: Topic) { return topic.charAt(0).toUpperCase() + topic.slice(1); }
function truncateId(id: string) { return id.length > 12 ? `${id.slice(0, 12)}…` : id; }
function TopicBadge({ value }: { value: Topic }) {
  return <span className={value === "design" || value === "copy" ? "font-medium text-foreground" : ""}>{value}</span>;
}

function ActionIcon({ icon, label, disabled, onClick, variant = "ghost", className = "" }: {
  icon: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
  variant?: ButtonProps["variant"];
  className?: string;
}) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <Button className={`size-7 p-0 ${className}`} type="button" size="icon" variant={variant} aria-label={label} disabled={disabled} onClick={onClick}>
        <Icon name={icon} aria-hidden />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>;
}

function Delete({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return <ActionIcon icon="Trash2" label="Delete" className="text-muted-foreground hover:text-destructive" disabled={disabled} onClick={() => { if (window.confirm(`Delete ${label}?`)) onClick(); }} />;
}

function Meta({ children }: { children: React.ReactNode }) {
  return <div className="mt-1.5 break-words text-xs tabular-nums text-muted-foreground">{children}</div>;
}

type FormProps = { form: Record<string, string>; setForm: React.Dispatch<React.SetStateAction<Record<string, string>>> };
function set(key: string, setForm: FormProps["setForm"]) {
  return (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
}
function emptyForm() {
  return { key: "", kind: "fact", topic: "engineering", value: "", category: "Execution", situation: "", action: "", priority: "50", severity: "minor", summary: "", prevention: "", acceptance: "" };
}
function relevantScopes(data: Dashboard) {
  return data.scopes
    .filter((scope) => data.currentEnvironmentId === null || scope.type !== "environment" || scope.id === data.currentEnvironmentId)
    .sort((left, right) => scopeOrder(left) - scopeOrder(right));
}
function scopeOrder(scope: Scope) { return scope.type === "project" ? 0 : scope.type === "environment" ? 1 : 2; }
function scopeLabel(scope: Scope) {
  return scope.type === "project" ? "Repository" : scope.type === "environment" ? "This worktree" : "Everywhere";
}
function scopeDescription(scope: Scope) {
  return scope.type === "project" ? "shared by every worktree" : scope.type === "environment" ? "only this worktree" : "all repositories";
}
function recordScopeLabel(scope: ScopeOption) {
  return scope.type === "global" ? "everywhere" : scope.type === "project" ? `repository ${scope.label}` : `worktree ${scope.label}`;
}
function scopeValue(scope: Scope) { return `${scope.type}:${scope.id}`; }
function viewLabel(view: View) { return view === "review" ? "Review" : view === "guidance" ? "Guidance" : "History"; }
function recordTypeLabel(type: RecordType) { return type === "context" ? "Context" : type === "napkin" ? "Napkin" : "Papercut"; }
function recordTypeDescription(type: RecordType) {
  return type === "context"
    ? "An agreed fact or preference that should remain active."
    : type === "napkin"
      ? "A reusable lesson for a situation that may happen again."
      : "A recurring friction point that should enter the review queue.";
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : "Clasi request failed"; }
function MoreSettings() {
  const navigate = useBbNavigate();
  return <section className="space-y-4">
    <h2 className="text-sm font-medium text-foreground">More</h2>
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border bg-surface-recessed/70 p-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">Setup and retention</p>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">Scopes, privacy rules, and optional Pinpoint learnings.</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel("clasi", { subPath: "setup" })}>Open guide</Button>
    </div>
  </section>;
}

function SetupPage() {
  const navigate = useBbNavigate();
  return <ScrollArea className="clasi-page h-full min-h-0 bg-background text-foreground">
    <main className="mx-auto w-full max-w-[760px] space-y-5 px-4 py-6">
      <PageIntro view="setup" />
      <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("clasi")}>Back to Clasi</Button>
      <section className="space-y-3 text-sm">
        <h2 className="font-medium">Choose a scope</h2>
        <dl className="divide-y divide-border-hairline rounded-md border border-border bg-surface-recessed/70 px-3">
          <div className="py-3"><dt className="font-medium">Everywhere</dt><dd className="mt-1 text-muted-foreground">Shared across this BB server.</dd></div>
          <div className="py-3"><dt className="font-medium">Repository</dt><dd className="mt-1 text-muted-foreground">Shared by worktrees with the same canonical Git remote. Non-Git projects use the BB project ID.</dd></div>
          <div className="py-3"><dt className="font-medium">This worktree</dt><dd className="mt-1 text-muted-foreground">Limited to one environment. Worktree guidance overrides repository guidance with the same key; repository guidance overrides global guidance.</dd></div>
        </dl>
      </section>
      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Retention and privacy</h2>
        <p className="text-muted-foreground">Store only generalized facts, preferences, lessons, and fixable workflow feedback. Never retain raw messages, source excerpts, paths, secrets, personal information, or customer data. Automated checks are not a complete privacy filter.</p>
        <p className="text-muted-foreground">Native Configuration controls the active instruction budget, not stored-record retention. Records stay in private plugin storage until you remove them. Papercut details stay out of agent instructions; only open severity counts are injected.</p>
      </section>
      <details className="rounded-md border border-border bg-surface-recessed/70 p-3 text-sm">
        <summary className="cursor-pointer font-medium">Optional Pinpoint learnings</summary>
        <p className="mt-2 text-muted-foreground">Clasi works alone. If you separately install Pinpoint, its review flow can save a proposed design or copy preference only after your explicit learning approval. Approval without the learning opt-in writes nothing. Clasi never discovers, installs, or enables Pinpoint.</p>
        <p className="mt-2 text-muted-foreground">Design and copy decisions require explicit acceptance. A consent reference is audit metadata, not a permission grant. Entries without one remain visible for review.</p>
      </details>
    </main>
  </ScrollArea>;
}


export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "clasi",
    title: "Clasi",
    icon: "clasi/brain",
    path: "clasi",
    component: ({ subPath }) => subPath === "setup" ? <SetupPage /> : <ClasiPanel />,
  });
  app.slots.settingsSection({ id: "more", component: MoreSettings });
});
