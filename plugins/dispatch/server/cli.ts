// `bb dispatch …` subcommands except `call` (P3) and `import` (P4).
// Owned by P1. P0 left placeholders that fail with a clear message.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import type { CliCommands, ServerContext } from "./context.js";

const json = { json: { type: "boolean", description: "Emit machine-readable JSON" } } as const;

const notBuilt = (): never => {
  throw new PluginCliError("This Dispatch command is not built yet.", { code: "not_implemented" });
};

export function coreCommands(_ctx: ServerContext): CliCommands {
  return {
    live: cliCommand({ summary: "List threads that are working now", options: json, run: notBuilt }),
    read: cliCommand({
      summary: "Print what a thread did last",
      positionals: [{ name: "thread-id", description: "The thread to read", required: true }],
      run: notBuilt,
    }),
    usage: cliCommand({
      summary: "Voice minutes and estimated cost per day",
      options: {
        ...json,
        days: { type: "integer", min: 1, max: 365, default: 30, description: "How many days back to report" },
      },
      run: notBuilt,
    }),
    stop: cliCommand({ summary: "End the live call on every device", run: notBuilt }),
    mute: cliCommand({ summary: "Mute the microphone on the live call", run: notBuilt }),
    unmute: cliCommand({ summary: "Unmute the microphone on the live call", run: notBuilt }),
    status: cliCommand({ summary: "Show what is set up and whether a call is live", options: json, run: notBuilt }),
  };
}
