// Owned by P4: the one-time import from the earlier voice plugin.
// P0 left placeholders only.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import type { CliCommands, ImportHandlers, ServerContext } from "./context.js";
import { notImplemented } from "./context.js";

export function importRpcHandlers(_ctx: ServerContext): ImportHandlers {
  return notImplemented(["importHandsfree"]);
}

/** `bb dispatch import --from handsfree [--dry-run] [--include-legacy-usage]`. */
export function importCommands(_ctx: ServerContext): CliCommands {
  return {
    import: cliCommand({
      summary: "Import settings and history from the earlier voice plugin",
      options: {
        from: { type: "enum", values: ["handsfree"], description: "Where to import from. Only handsfree is supported", required: true },
        "dry-run": { type: "boolean", description: "Report what would be imported and write nothing" },
        "include-legacy-usage": { type: "boolean", description: "Also copy the old token usage rows. They are skipped by default" },
      },
      run() {
        throw new PluginCliError("Import is not built yet.", { code: "not_implemented" });
      },
    }),
  };
}
