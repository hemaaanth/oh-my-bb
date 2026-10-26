// `bb dispatch …` subcommands except `call` (P3).
// Owned by P1. Every failure exits non-zero with one line of reason.
import { PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError, cliCommand, type PluginCliResult } from "@get-bb/plugin-sdk";
import { CHANNELS, LIVE_USD_PER_MINUTE } from "../shared/constants.js";
import type { AgentCommand, LiveJson, LiveStatus, SetupStatus, StatusJson, UsageReport } from "../shared/contract.js";
import type { CliCommands, ServerContext } from "./context.js";
import { callsPage, liveStatus, usageReport } from "./ledger.js";
import { endCallsEverywhere } from "./live-session.js";
import { forgetCall } from "./memory.js";
import { readSetupStatus } from "./readiness.js";
import { listLiveThreads } from "./tools/live.js";
import { readThread } from "./tools/threads.js";

const json = { json: { type: "boolean", description: "Emit machine-readable JSON" } } as const;

export const NO_CALL = "No call is live";
export const PRICING_NOTE = `GPT-Live voice at $${LIVE_USD_PER_MINUTE.toFixed(2)} per minute. Reasoning model tokens are billed separately by OpenAI and are not counted here.`;

function ok(value: unknown, human: string, asJson: boolean | undefined): PluginCliResult {
  const stdout = asJson ? JSON.stringify(value, null, 2) : human;
  if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
    throw new PluginCliError("The output is too large. Ask for fewer days or use the app.", { code: "output_too_large" });
  }
  return { exitCode: 0, stdout };
}

/** Turn any failure into a one-line CLI error. */
async function attempt(run: () => Promise<PluginCliResult> | PluginCliResult): Promise<PluginCliResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PluginCliError(message.split("\n")[0] || "Dispatch failed.", { code: "failed" });
  }
}

const minutes = (seconds: number): string => `${(seconds / 60).toFixed(1)} min`;
const dollars = (usd: number): string => `$${usd.toFixed(2)}`;

function liveLine(live: LiveStatus): string {
  if (!live.live) return "Call: none live";
  const where = live.channel === "phone" ? "on the phone" : `in the app${live.device?.label ? ` (${live.device.label})` : ""}`;
  return `Call: live ${where}`;
}

/** Text form of `status`. Field names and missing labels only, never values. */
export function statusText(status: SetupStatus, live: LiveStatus): string {
  const mode = (name: string, ready: boolean, missing: readonly string[]) =>
    `${name}: ${ready ? "ready" : `not ready (missing: ${missing.join(", ")})`}`;
  const lines = [
    `Dispatch ${status.version}`,
    mode("Voice", status.voice.ready, status.voice.missing),
    mode("Phone", status.phone.ready, status.phone.missing),
    `Webhooks plugin: ${status.phone.webhooksPlugin}`,
  ];
  if (status.reloadPending) lines.push("The OpenAI key was saved. Reload Dispatch to apply it.");
  lines.push(liveLine(live));
  return lines.join("\n");
}

export function usageText(report: UsageReport): string {
  const lines = report.perDay
    .filter((day) => day.seconds > 0 || day.calls > 0)
    .map((day) => `${day.day}  ${minutes(day.seconds).padStart(10)}  ${dollars(day.usd).padStart(8)}  ${day.calls} call${day.calls === 1 ? "" : "s"}`);
  if (lines.length === 0) lines.push(`No calls in the last ${report.days} days.`);
  lines.push(`Total       ${minutes(report.totalSeconds).padStart(10)}  ${dollars(report.totalUsd).padStart(8)}`);
  lines.push(PRICING_NOTE);
  return lines.join("\n");
}

function relay(ctx: ServerContext, command: AgentCommand, done: string): PluginCliResult {
  if (!liveStatus(ctx).live) throw new PluginCliError(NO_CALL, { code: "no_call" });
  ctx.bb.realtime.publish(CHANNELS.agentCommand, { command, nonce: null });
  return { exitCode: 0, stdout: done };
}

export function coreCommands(ctx: ServerContext): CliCommands {
  return {
    live: cliCommand({
      summary: "List threads that are working now",
      options: json,
      run: ({ options }) =>
        attempt(async () => {
          const threads = await listLiveThreads(ctx);
          const value: LiveJson = {
            threads: threads.map((thread) => ({
              id: thread.id,
              title: thread.title,
              status: thread.status,
              projectName: thread.projectName,
              machineName: thread.machineName,
              since: thread.since,
            })),
          };
          const human =
            threads.length === 0
              ? "No threads are working now."
              : threads.map((thread) => `${thread.status.padEnd(12)} ${thread.title}: ${thread.projectName}, ${thread.machineName}, ${thread.ago}`).join("\n");
          return ok(value, human, options.json);
        }),
    }),
    read: cliCommand({
      summary: "Print what a thread did last",
      positionals: [{ name: "thread-id", description: "The thread to read", required: true }],
      run: ({ positionals }) =>
        attempt(async () => {
          const result = JSON.parse(await readThread(ctx, { thread_id: positionals["thread-id"] })) as {
            title: string;
            status: string;
            project: string;
            machine: string;
            latestOutput?: string;
            lastOutcome?: { summary: string; detail?: string };
          };
          const body = result.latestOutput ?? [result.lastOutcome?.summary, result.lastOutcome?.detail].filter(Boolean).join("\n");
          return { exitCode: 0, stdout: `${result.title} (${result.status})\n${result.project}, ${result.machine}\n\n${body}` };
        }),
    }),
    usage: cliCommand({
      summary: "Voice minutes and estimated cost per day",
      options: {
        ...json,
        days: { type: "integer", min: 1, max: 365, default: 30, description: "How many days back to report" },
      },
      run: ({ options }) =>
        attempt(() => {
          const report = usageReport(ctx, options.days);
          return ok({ ...report, note: PRICING_NOTE }, usageText(report), options.json);
        }),
    }),
    stop: cliCommand({
      summary: "End the live call on every device",
      run: () =>
        attempt(() => {
          const { stopped } = endCallsEverywhere(ctx, { reason: "stopped from the CLI" });
          return { exitCode: 0, stdout: stopped ? "Stopped" : NO_CALL };
        }),
    }),
    forget: cliCommand({
      summary: "Forget what was said in a call: its transcript and summary",
      positionals: [{ name: "call-id", description: "The call to forget. Defaults to the latest call", required: false }],
      run: ({ positionals }) =>
        attempt(() => {
          const callId = positionals["call-id"] ?? callsPage(ctx, { limit: 1 }).calls[0]?.id;
          if (!callId) throw new PluginCliError("There are no calls to forget.", { code: "no_call" });
          if (!forgetCall(ctx, callId)) throw new PluginCliError(`There is no call with id ${callId}.`, { code: "not_found" });
          return { exitCode: 0, stdout: `Forgot ${callId}. Its transcript and summary are deleted.` };
        }),
    }),
    mute: cliCommand({ summary: "Mute the microphone on the live call", run: () => attempt(() => relay(ctx, "mute", "Muted")) }),
    unmute: cliCommand({ summary: "Unmute the microphone on the live call", run: () => attempt(() => relay(ctx, "unmute", "Unmuted")) }),
    status: cliCommand({
      summary: "Show what is set up and whether a call is live",
      options: json,
      run: ({ options }) =>
        attempt(async () => {
          const status = await readSetupStatus(ctx);
          const live = liveStatus(ctx);
          const value: StatusJson = { ...status, live };
          return ok(value, statusText(status, live), options.json);
        }),
    }),
  };
}
