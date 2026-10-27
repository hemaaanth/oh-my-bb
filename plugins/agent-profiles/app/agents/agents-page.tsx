import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { Profile, rpcContract } from "../../server/contract";
import { AgentCollection } from "./agent-collection";
import { AgentDetail, agentTabs } from "./agent-detail";
import { ProfileForm } from "./profile-form";
import { BackButton, ErrorMessage, message } from "../shared/ui";

export function AgentsPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const nextProfiles = await rpc.call("listProfiles");
      if (sequence !== request.current) return;
      setProfiles(nextProfiles);
      setError(null);
      setLoaded(true);
    } catch (cause) {
      if (sequence !== request.current) return;
      setError(message(cause));
      setLoaded(true);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);
  useRealtime("profiles-changed", () => { void load(); });

  const [id, section] = subPath.split("/").filter(Boolean);
  if (id === "new") {
    if (!loaded) {
      return (
        <div className="bot-page">
          <div className="bot-config-content">
            <p role="status" className="text-sm text-muted-foreground">Loading agents…</p>
          </div>
        </div>
      );
    }
    return (
      <div className="bot-page bot-create-page">
        <div className="bot-config-content">
          <div className="bot-create-title">
            <BackButton />
            <div>
              <h1>New agent</h1>
              <p className="text-xs text-muted-foreground">Create a reusable identity and execution profile.</p>
            </div>
          </div>
          <ProfileForm
            makeDefault={profiles.length === 0}
            onSaved={async (profile) => {
              await load();
              navigate.toPluginPanel("agents", {
                subPath: `${profile.id}/${profile.kind === "thin" ? "profile" : "mission"}`,
              });
            }}
            onCancel={() => navigate.toPluginPanel("agents")}
          />
        </div>
      </div>
    );
  }

  if (id) {
    const profile = profiles.find((candidate) => candidate.id === id);
    if (!loaded) {
      return (
        <div className="bot-page">
          <div className="bot-config-content">
            <p role="status" className="text-sm text-muted-foreground">Loading agent…</p>
          </div>
        </div>
      );
    }
    if (!profile) {
      return (
        <div className="bot-page">
          <div className="mx-auto max-w-xl space-y-3">
            <BackButton />
            <ErrorMessage error={error ?? "Agent not found."} />
          </div>
        </div>
      );
    }
    const requestedTab = agentTabs.includes(section as (typeof agentTabs)[number])
      ? section as (typeof agentTabs)[number]
      : "profile";
    const tab = profile.kind === "thin" && (requestedTab === "mission" || requestedTab === "persona")
      ? "profile"
      : requestedTab;
    return (
      <div className="bot-route">
        <AgentDetail key={profile.id} profile={profile} tab={tab} onReload={load} />
      </div>
    );
  }

  return <AgentCollection profiles={profiles} loading={!loaded} error={error} />;
}
