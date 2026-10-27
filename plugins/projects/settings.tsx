import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRpc,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import type { scriptsPreferencesContract } from "./scripts-runtime/feature";

type Preferences = PluginRpcResult<(typeof rpcContract)["preferences"]>;
export const integrationRows = [
  [
    "catalogIntegration",
    "Executor",
    "bundles",
    "Load skill choices and notify Executor when assignments change.",
  ],
  [
    "agentsIntegration",
    "Agents",
    "agentPreferences",
    "Load agent choices and notify Agents when assignments change.",
  ],
  [
    "sidebarIntegration",
    "Status Sidebar",
    null,
    "Notify Status Sidebar when project groups change.",
  ],
  [
    "tasksIntegration",
    "Tasks",
    null,
    "Include linked tasks when explicitly generating routing profiles.",
  ],
] as const;
const controlClass =
  "h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring";

function useProjectPreferences() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await rpc.call("preferences");
      if (request === sequence.current) {
        setData(next);
        setError(null);
      }
    } catch (cause) {
      if (request === sequence.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  useRealtime("projects-configuration-changed", () => {
    void load();
  });
  async function save(patch: Partial<Preferences>) {
    const request = ++sequence.current;
    setSaving(true);
    setError(null);
    try {
      const next = await rpc.call("updatePreferences", patch);
      if (request === sequence.current) setData(next);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { data, error, saving, load, save, clearError: () => setError(null) };
}

export function PreferencesSettings() {
  const { data, error, saving, load, save, clearError } =
    useProjectPreferences();
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useRef<string | null>(null);
  const commit = useCallback(
    async (value: string) => {
      const next = value.trim();
      if (
        !next ||
        next === data?.routingModel ||
        sent.current === next ||
        saving
      )
        return;
      sent.current = next;
      const ok = await save({ routingModel: next });
      sent.current = null;
      if (ok)
        setDraft((current) => (current?.trim() === next ? null : current));
    },
    [data?.routingModel, saving, save],
  );
  useEffect(() => {
    if (draft === null || error) return;
    const timer = setTimeout(() => {
      void commit(draft);
    }, 600);
    return () => clearTimeout(timer);
  }, [draft, commit, error]);
  return (
    <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <h2 className="text-sm font-medium">Preferences</h2>
      {!data ? (
        <p
          role={error ? "alert" : "status"}
          className="text-sm text-muted-foreground"
        >
          {error ?? "Loading preferences…"}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : (
        <>
          <div className="divide-y divide-border rounded-md border border-border bg-surface-recessed/70 px-3">
            <div className="@container py-3">
              <div className="flex flex-col gap-2.5 @md:flex-row @md:items-center @md:justify-between @md:gap-5">
                <div className="min-w-0 flex-1">
                  <label htmlFor="projects-profile-model" className="text-sm">
                    Project profile model
                  </label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    For explicit profile generation and learning.
                  </p>
                </div>
                <input
                  id="projects-profile-model"
                  className={`${controlClass} w-full min-w-0 @md:w-72`}
                  value={draft ?? data.routingModel}
                  onChange={(e) => {
                    clearError();
                    setDraft(e.target.value);
                  }}
                  onBlur={(e) => {
                    void commit(e.target.value);
                  }}
                />
              </div>
            </div>
            <ScriptsPreference />
          </div>
          <p role="status" className="text-xs text-muted-foreground">
            {saving
              ? "Saving…"
              : error
                ? "Could not save. Your draft is kept."
                : "Changes save automatically."}
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => {
                  if (draft) void commit(draft);
                }}
              >
                Retry
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
function ScriptsPreference() {
  const rpc = useRpc<typeof scriptsPreferencesContract>();
  const [value, setValue] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void rpc
      .call("scriptsPreferences")
      .then((v) => setValue(v.autoStartServices))
      .catch((e) => setError(String(e)));
  }, [rpc]);
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <label htmlFor="projects-autostart" className="text-sm">
          Start workspace services automatically
        </label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Start declared services when a workspace becomes active.
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <button
        id="projects-autostart"
        type="button"
        role="switch"
        aria-checked={value ?? false}
        disabled={busy || value === null}
        className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border ${value ? "bg-foreground" : "bg-input"} disabled:opacity-40`}
        onClick={() => {
          setBusy(true);
          setError(null);
          void rpc
            .call("saveScriptsPreferences", { autoStartServices: !value })
            .then((v) => setValue(v.autoStartServices))
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        <span
          className={`size-4 rounded-full ${value ? "translate-x-4 bg-background" : "bg-foreground"}`}
        />
      </button>
    </div>
  );
}

export function IntegrationSettings() {
  const { data, error, saving, load, save } = useProjectPreferences();
  return (
    <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <h2 className="text-sm font-medium text-foreground">Oh My BB</h2>
      <div className="divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3">
        {integrationRows.map(([key, label, _kind, description]) => (
          <div
            key={key}
            className="flex min-w-0 items-center justify-between gap-4 py-3"
          >
            <div className="min-w-0">
              <label htmlFor={`projects-${key}`} className="text-sm">
                {label}
              </label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </p>
            </div>
            <button
              id={`projects-${key}`}
              type="button"
              role="switch"
              aria-checked={data?.[key] ?? false}
              disabled={saving || !data}
              onClick={() => void save({ [key]: !data?.[key] })}
              className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${data?.[key] ? "border-foreground bg-foreground" : "border-input bg-input"}`}
            >
              <span
                className={`pointer-events-none block size-4 rounded-full transition-transform ${data?.[key] ? "translate-x-4 bg-background" : "translate-x-0 bg-foreground"}`}
              />
            </button>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => void load()}
          >
            Retry
          </button>
        </p>
      )}
    </section>
  );
}
