import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRpc,
  useRealtime,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import type { environmentRpcContract } from "./rpc";
import type { projectEnvironmentContract } from "./project-contract";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Snapshot = PluginRpcResult<
  (typeof environmentRpcContract)["environment_snapshot"]
>;
type Fields = {
  name: string;
  environmentName: string;
  environmentId: string;
  account: string;
  serviceAccountName: string;
};
const empty: Fields = {
  name: "",
  environmentName: "",
  environmentId: "",
  account: "",
  serviceAccountName: "",
};
const inputClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";
export function EnvironmentEditor({
  selectedProjectId,
}: {
  selectedProjectId: string;
}) {
  const rpc = useRpc<typeof environmentRpcContract>();
  const editor = useRpc<typeof projectEnvironmentContract>();
  const [data, setData] = useState<Snapshot | null>(null);
  const projectId = selectedProjectId;
  const [draft, setDraft] = useState<Fields>(empty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [confirmShared, setConfirmShared] = useState(false);
  const dirty = useRef(false);
  const baseline = useRef<{ id: string | null; updatedAt: string | null }>({
    id: null,
    updatedAt: null,
  });
  const load = useCallback(async () => {
    const next = await rpc.call("environment_snapshot");
    setData(next);
  }, [rpc]);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [load]);
  useRealtime("project-environments-changed", () => {
    void load().catch((e) => setError(String(e)));
  });
  const project = data?.projects.find((p) => p.id === projectId);
  const profile = data?.profiles.find((p) => p.id === project?.profileId);
  useEffect(() => {
    if (dirty.current) return;
    setDraft(
      profile
        ? {
            name: profile.name,
            environmentName: profile.environmentName,
            environmentId: profile.environmentId,
            account: profile.account,
            serviceAccountName: profile.serviceAccountName,
          }
        : { ...empty, name: project ? `${project.name} environment` : "" },
    );
    baseline.current = {
      id: profile?.id ?? null,
      updatedAt: profile?.updatedAt ?? null,
    };
  }, [profile, project]);
  const sharedProjects =
    data?.projects.filter((p) => profile && p.profileId === profile.id) ?? [];
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      {!data && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading environments…
        </p>
      )}
      {data && project && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await editor.call("saveProjectEnvironment", {
                projectId,
                expectedProfileId: baseline.current.id,
                expectedUpdatedAt: baseline.current.updatedAt,
                ...draft,
                confirmShared,
              });
              dirty.current = false;
            });
          }}
        >
          <div className="divide-y divide-border rounded-lg border border-border px-3">
            {(
              [
                ["name", "Name"],
                ["environmentName", "Environment name"],
                ["environmentId", "1Password environment ID"],
                ["account", "1Password account"],
                ["serviceAccountName", "Service account name"],
              ] as const
            ).map(([key, label]) => (
              <div
                key={key}
                className="grid min-w-0 gap-2 py-3 @md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
              >
                <label htmlFor={`environment-${key}`} className="text-sm">
                  {label}
                </label>
                <input
                  id={`environment-${key}`}
                  className={inputClass}
                  value={draft[key]}
                  onChange={(event) => {
                    dirty.current = true;
                    setDraft((old) => ({ ...old, [key]: event.target.value }));
                  }}
                />
              </div>
            ))}
            {profile && (
              <div className="grid min-w-0 gap-2 py-3">
                <label className="text-sm" htmlFor="environment-token">
                  Service-account token{" "}
                  <span className="text-xs text-muted-foreground">
                    ·{" "}
                    {profile.tokenConfigured ? "configured" : "not configured"}
                  </span>
                </label>
                <div className="flex min-w-0 gap-2">
                  <input
                    id="environment-token"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      profile.tokenConfigured ? "Replace token…" : "Add token…"
                    }
                    className={inputClass}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <button
                    type="button"
                    className="h-9 shrink-0 whitespace-nowrap rounded-md border border-border px-3 text-xs disabled:opacity-50"
                    disabled={busy || !token.trim()}
                    onClick={() =>
                      void action(async () => {
                        if (!baseline.current.id || !baseline.current.updatedAt)
                          throw new Error("Save the environment first");
                        await editor.call("setProjectEnvironmentToken", {
                          projectId,
                          expectedProfileId: baseline.current.id,
                          expectedUpdatedAt: baseline.current.updatedAt,
                          token,
                          confirmShared,
                        });
                        setToken("");
                      })
                    }
                  >
                    Save token
                  </button>
                </div>
              </div>
            )}
          </div>
          {sharedProjects.length > 1 && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmShared}
                onChange={(event) => setConfirmShared(event.target.checked)}
              />
              Apply edits to the existing shared configuration used by{" "}
              {sharedProjects.map((p) => p.name).join(" and ")}.
            </label>
          )}
          <div className="flex justify-end">
            <button
              className={inputClass + " !w-auto px-4 disabled:opacity-50"}
              disabled={busy || !draft.name.trim()}
              type="submit"
            >
              {busy ? "Saving…" : "Save environment"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
