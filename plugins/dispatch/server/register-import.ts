// Owned by P4: the one-time import from the earlier voice plugin (SPEC §17).
// The work is in import-handsfree.ts. This file wires it to RPC and the CLI.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import type { CliCommands, ImportHandlers, ServerContext } from "./context.js";
import { ImportError, describeReport, runHandsfreeImport } from "./import-handsfree.js";

const asRpcError = (error: unknown): never => {
  if (error instanceof ImportError) throw new Error(error.message);
  throw error;
};

export function importRpcHandlers(ctx: ServerContext): ImportHandlers {
  return {
    importHandsfree: async ({ dryRun, includeLegacyUsage }) => {
      try {
        return await runHandsfreeImport(ctx, { dryRun, includeLegacyUsage });
      } catch (error) {
        return asRpcError(error);
      }
    },
  };
}

/**
 * `bb dispatch import --from handsfree [--apply] [--include-legacy-usage]`.
 * It is a dry run unless `--apply` is given, so the first run changes nothing.
 */
export function importCommands(ctx: ServerContext): CliCommands {
  return {
    import: cliCommand({
      summary: "Import settings and history from the earlier voice plugin",
      description:
        "Reads the earlier plugin's settings, setup values and call history and copies them into Dispatch. It never changes the earlier plugin. " +
        "By default this is a dry run: it reports what would be copied and writes nothing. Pass --apply to write. " +
        "Setup values are reported as copied, absent or invalid, never shown. The import runs once.",
      options: {
        from: { type: "enum", values: ["handsfree"], description: "Where to import from. Only handsfree is supported", required: true },
        "dry-run": { type: "boolean", description: "Report what would be imported and write nothing. This is already the default" },
        apply: { type: "boolean", description: "Write the changes. Without it the import is a dry run" },
        "include-legacy-usage": { type: "boolean", description: "Also copy the old token usage rows. They are skipped by default" },
        json: { type: "boolean", description: "Emit the report as JSON" },
      },
      async run({ options }) {
        if (options["dry-run"] && options.apply) {
          throw new PluginCliError("Use either --dry-run or --apply, not both.", { code: "invalid_arguments" });
        }
        try {
          const report = await runHandsfreeImport(ctx, { dryRun: !options.apply, includeLegacyUsage: options["include-legacy-usage"] === true });
          return { exitCode: 0, stdout: options.json ? `${JSON.stringify(report, null, 2)}\n` : describeReport(report) };
        } catch (error) {
          if (error instanceof ImportError) throw new PluginCliError(error.message, { code: "import_failed" });
          throw error;
        }
      },
    }),
  };
}
