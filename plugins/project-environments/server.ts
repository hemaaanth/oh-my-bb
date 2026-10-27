import type { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { environmentCliContract } from "./cli-contract.js";
import { rpcContract } from "./contract.js";
const preparations = new Set(["prepare", "startPrepare", "preparationStatus", "preparationOutcomeV1", "workspaceSelection", "cleanupPreparation"]);
const summaries = new Set(["snapshot", "listCredentials", "legacySnapshot"]);
export default function compatibility(bb: BbPluginApi) {
  const handlers = Object.fromEntries(Object.entries(rpcContract).map(([name, contract]) => [name, async (input: unknown, context: any) => {
    const caller = context?.experimental_caller;
    if (caller?.kind !== "client" && !(caller?.kind === "plugin" && (summaries.has(name) || caller.pluginId === "projects" && name === "refreshProject" || caller.pluginId === "sandboxes" && preparations.has(name)))) throw new Error("Use Projects to manage application environments");
    return bb.sdk.plugins.callRpc({ pluginId: "projects", method: `environment_${name}`, input: input as never, outputSchema: contract.output as z.ZodType<any> });
  }]));
  bb.rpc.register(rpcContract, handlers as never);
  bb.cli.register({
    name: "project-env", summary: "Manage application environments in Projects",
    commands: [
      { name: "list", summary: "List credential sets and project assignments", usage: "bb project-env list [--json]" },
      { name: "prepare", summary: "Reconcile a project's local or explicit machine checkout", usage: "bb project-env prepare [--project <id>] [--host <id> --workspace <path>] [--strict] [--json]" },
      { name: "import-credential", summary: "Consume a native bb Secrets handoff for one credential set", usage: "bb project-env import-credential --profile <id-or-name> --file <path> [--environment-id-var <name>] [--token-var <name>]" },
      { name: "import-credentials", summary: "Consume one native bb Secrets handoff for selected credential sets", usage: "bb project-env import-credentials --file <path> --profile <id-or-name> [--profile <id-or-name> ...]" },
      { name: "bind", summary: "Assign a credential set to a BB project", usage: "bb project-env bind --project <id-or-name> --profile <id-or-name>" },
      { name: "unbind", summary: "Remove a BB project's credential assignment", usage: "bb project-env unbind --project <id-or-name>" },
      { name: "set-setup", summary: "Set a credential set's non-secret machine setup script", usage: "bb project-env set-setup --profile <id-or-name> --file <path>" },
      { name: "enable-tool", summary: "Enable a project-scoped tool on a credential set", usage: "bb project-env enable-tool --profile <id-or-name> --tool <capability>" },
      { name: "cleanup", summary: "Remove staged credential data and readiness bookkeeping", usage: "bb project-env cleanup --project <id> --host <id> --workspace <path>" },
      { name: "seed", summary: "Create the suggested starter credential sets", usage: "bb project-env seed [--json]" },
      { name: "run", summary: "Run a command with the current project's scoped 1Password Environment", usage: "bb project-env run -- <command> [args...]" },
    ],
    run: (argv, context) => bb.sdk.plugins.callRpc({ pluginId: "projects", method: "environment_cli", input: { argv, ...(context.cwd ? { cwd: context.cwd } : {}), ...(context.threadId ? { threadId: context.threadId } : {}), ...(context.projectId ? { projectId: context.projectId } : {}) }, outputSchema: environmentCliContract.environment_cli.output }),
  });
}
