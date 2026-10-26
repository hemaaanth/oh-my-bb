// Tools (SPEC §12.6): which plugins the agent may run.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { PLUGIN_ID } from "../../shared/constants.js";
import type { PluginAccess, RpcContract } from "../../shared/contract.js";
import { Checkbox } from "../components/ui/checkbox";
import { errorText, useLatest, usePreferences } from "./data.js";
import { Group, Loading, Note, Row, SettingSelect } from "./layout.js";

type Installed = { id: string; name: string; command: string; summary: string };

function PluginAccessEditor({ access, save }: { access: PluginAccess; save: (access: PluginAccess) => Promise<boolean> }) {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [plugins, setPlugins] = useState<Installed[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (access.mode !== "selected" || plugins) return;
    let active = true;
    rpcRef.current
      .call("pluginsWithCommands", {})
      .then((result) => active && setPlugins(result.plugins.filter((plugin) => plugin.id !== PLUGIN_ID)))
      .catch((cause: unknown) => active && setError(errorText(cause)));
    return () => {
      active = false;
    };
  }, [access.mode, plugins, rpcRef]);

  const chosen = new Set(access.mode === "selected" ? access.ids : []);
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    void save({ mode: "selected", ids: [...next] });
  };

  return (
    <>
      <Row label="Plugins the agent may run" htmlFor="dispatch-plugin-access" help="Allow the agent to run plugin commands.">
        <SettingSelect
          id="dispatch-plugin-access"
          label="Plugins the agent may run"
          value={access.mode}
          options={[{ value: "all", label: "All plugins" }, { value: "none", label: "None" }, { value: "selected", label: "Selected plugins" }]}
          onValueChange={(value) => {
            const mode = value as PluginAccess["mode"];
            void save(mode === "selected" ? { mode, ids: [] } : { mode });
          }}
        />
      </Row>
      {access.mode === "selected" ? (
        <div className="py-3">
          {!plugins ? <Loading error={error} /> : null}
          {plugins?.length === 0 ? <Note>No other plugin offers a command the agent could run.</Note> : null}
          <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto overscroll-contain">
            {plugins?.map((plugin) => (
              <li key={plugin.id}>
                <label className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-state-hover">
                  <Checkbox className="mt-0.5" checked={chosen.has(plugin.id)} onCheckedChange={() => toggle(plugin.id)} aria-label={plugin.name} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">{plugin.name}</span>
                    <span className="text-xs text-muted-foreground">{plugin.summary}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function ToolsSection() {
  const { prefs, error, save } = usePreferences();
  if (!prefs) return <Loading error={error} />;
  return (
    <Group title="Plugin access">
      <PluginAccessEditor access={prefs.pluginAccess} save={(pluginAccess) => save({ pluginAccess })} />
      {error ? <Note tone="error">{error}</Note> : null}
    </Group>
  );
}
