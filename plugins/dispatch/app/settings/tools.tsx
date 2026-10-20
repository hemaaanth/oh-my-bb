// Tools (SPEC §12.6): which plugins the agent may run, and the read-only list of
// built-in tools. The list comes from the server's tool catalog.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { PLUGIN_ID } from "../../shared/constants.js";
import type { PluginAccess, RpcContract, ToolSpec } from "../../shared/contract.js";
import { Badge } from "../components/ui/badge";
import { errorText, useLatest, usePreferences } from "./data.js";
import { Group, Loading, Note, Row, selectClass } from "./layout.js";

type Installed = { id: string; name: string; command: string; summary: string };

/** Where a tool runs, in the words the owner knows: the app, the server, or a phone call. */
function tags(tool: ToolSpec, phoneNames: ReadonlySet<string>): string[] {
  const where: string[] = tool.runsOn === "both" ? ["app", "server"] : [tool.runsOn];
  if (phoneNames.has(tool.name)) where.push("phone");
  return where;
}

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
      <Row label="Plugins the agent may run" htmlFor="dispatch-plugin-access" help="The agent can run commands of plugins you allow here.">
        <select
          id="dispatch-plugin-access"
          className={selectClass}
          value={access.mode}
          onChange={(event) => {
            const mode = event.target.value as PluginAccess["mode"];
            void save(mode === "selected" ? { mode, ids: [] } : { mode });
          }}
        >
          <option value="all">All plugins</option>
          <option value="none">None</option>
          <option value="selected">Selected plugins</option>
        </select>
      </Row>
      {access.mode === "selected" ? (
        <div className="flex flex-col gap-1 pb-3">
          {!plugins ? <Loading error={error} /> : null}
          {plugins?.length === 0 ? <Note>No other plugin offers a command the agent could run.</Note> : null}
          <ul className="flex flex-col">
            {plugins?.map((plugin) => (
              <li key={plugin.id}>
                <label className="flex cursor-pointer items-start gap-3 py-1.5">
                  <input type="checkbox" className="mt-1" checked={chosen.has(plugin.id)} onChange={() => toggle(plugin.id)} aria-label={plugin.name} />
                  <span className="flex min-w-0 flex-col">
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

function BuiltInTools() {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [tools, setTools] = useState<ToolSpec[] | null>(null);
  const [phoneNames, setPhoneNames] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Ask for the widest app catalog, so the list names every tool the agent can have.
    // The phone catalog says which of them also work on a call.
    Promise.all([
      rpcRef.current.call("toolCatalog", { mobile: true, canNavigate: true, channel: "app" }),
      rpcRef.current.call("toolCatalog", { mobile: false, canNavigate: false, channel: "phone" }),
    ])
      .then(([app, phone]) => {
        if (!active) return;
        setTools(app.tools);
        setPhoneNames(new Set(phone.tools.map((tool) => tool.name)));
      })
      .catch((cause: unknown) => active && setError(errorText(cause)));
    return () => {
      active = false;
    };
  }, [rpcRef]);

  return (
    <div className="flex flex-col gap-1 py-3">
      <h4 className="text-sm font-medium text-foreground">Built-in tools</h4>
      {!tools ? <Loading error={error} /> : null}
      <ul className="flex flex-col">
        {tools?.map((tool) => (
          <li key={tool.name} className="flex items-start justify-between gap-3 py-1.5">
            <div className="flex min-w-0 flex-col">
              <code className="text-sm text-foreground">{tool.name}</code>
              <span className="text-xs text-muted-foreground">{tool.description}</span>
            </div>
            <div className="flex shrink-0 gap-1">
              {tags(tool, phoneNames).map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ToolsSection() {
  const { prefs, error, save } = usePreferences();
  if (!prefs) return <Loading error={error} />;
  return (
    <Group>
      <PluginAccessEditor access={prefs.pluginAccess} save={(pluginAccess) => save({ pluginAccess })} />
      {error ? <Note tone="error">{error}</Note> : null}
      <BuiltInTools />
    </Group>
  );
}
