export const SCRIPTS_ICON = "workspace-scripts/scripts";

export function MoreSettings() {
  return <section className="space-y-4">
    <h2 className="text-sm font-medium text-foreground">More</h2>
    <details id="scripts-setup" className="rounded-md border border-border bg-surface-recessed/70 p-3">
      <summary className="cursor-pointer text-sm text-foreground">Setup guide</summary>
      <ScriptsSetup />
    </details>
  </section>;
}

function ScriptsSetup() {
  return (
    <div className="mt-4 space-y-5">
        <section className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-medium">Declare a command</h3>
          <p className="text-sm text-muted-foreground">Add bb.json at the checkout root. Open the thread header's actions menu, then Scripts. Selecting Run starts a BB terminal on that checkout's machine.</p>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface-recessed p-3 text-xs"><code>{`{
  "scripts": {
    "hello": {
      "command": "printf 'Hello from Scripts\\n'",
      "description": "Print a message"
    }
  }
}`}</code></pre>
        </section>
        <section className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-medium">Services and state</h3>
          <p className="text-sm text-muted-foreground">Use type: service for a foreground, environment-scoped process. worktree.terminals start when a thread becomes active unless Configuration disables it. Running services are shared by threads in that environment.</p>
          <p className="text-sm text-muted-foreground">The Scripts submenu shows terminal state and the last command's exit result. Set port or reference BB_PORT for an allocated service port. Use Copy output command to read native terminal output without starting it again.</p>
          <p className="text-sm text-muted-foreground">A listening port is not a health check or proof that this terminal owns the listener. Unknown ports are not guessed. Commands use the machine user's permissions and credentials; only run scripts from repositories you trust.</p>
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm">Compatibility and lifecycle hooks</summary>
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <p>bb.json takes precedence as a whole. paseo.json is read only when bb.json is absent. An invalid bb.json is an error, not a reason to run legacy commands.</p>
              <p>Services receive HOST=127.0.0.1. Assigned ports are also available under the legacy PASEO_PORT and PASEO_WORKTREE_PORT names.</p>
              <p>BB owns automatic .bb-env-setup.sh and .bb-env-teardown.sh execution. Scripts only offers manual reruns and manifest worktree.setup / worktree.teardown fallbacks. Native hook files take precedence. Manual teardown stops tracked workspace services first.</p>
            </div>
          </details>
        </section>
        <section id="scripts-preparation" className="space-y-3 border-t border-border pt-5">
          <h3 className="text-sm font-medium">Workspace preparation</h3>
          <p className="text-sm text-muted-foreground">Declare a one-shot script and reference it from agentSetup in bb.json. Run it from Scripts or the CLI. The manifest alone does not authorize automatic agent setup.</p>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface-recessed p-3 text-xs"><code>{`{
  "scripts": { "prepare-tools": { "command": "./scripts/prepare-tools.sh" } },
  "agentSetup": {
    "script": "prepare-tools",
    "env": { "PATH": "\${BB_WORKSPACE_DIR}/.tools/bin:\${PATH}" }
  }
}`}</code></pre>
          <p className="text-sm text-muted-foreground">Run bb workspace-scripts prepare for a blocking manual run. Existing approved agent startup preparation remains active without a Scripts settings section. Use bb workspace-scripts agent-setup list to inspect saved approvals.</p>
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm">Environment, native hooks and migrated recipes</summary>
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <p>Setup runs in the actual thread workspace. Environment values can reference HOME, PATH, BB_WORKSPACE_DIR and BB_SETUP_DIR using the dollar-brace syntax. Keep secrets in owner settings, not bb.json. The optional integration requires Agents setup-script support and a POSIX host with Python 3.</p>
              <p>Native lifecycle hooks can invoke the same preparation file directly. Do not call workspace-scripts setup from .bb-env-setup.sh: that command selects the same native hook. Existing agent homes do not create another environment-setup event.</p>
              <p>Previous security-tool selections retain only their pinned security recipe and original sandbox restriction. They do not authorize workspace commands. The standalone recipe is in recipes/security-tools; its Linux, Python 3 and uv checks, cache, shared lock and verified downloads remain intact.</p>
            </div>
          </details>
        </section>
    </div>
  );
}
