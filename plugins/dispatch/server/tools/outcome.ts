// Thread outcome and error summaries (SPEC §11.7). One summariser for
// read_thread, get_thread_error, and thread notices. Owned by P1.
import type { ServerContext } from "../context.js";

type Sdk = ServerContext["bb"]["sdk"];
export type ThreadEventRow = Awaited<ReturnType<Sdk["threads"]["events"]["list"]>>[number];

export type OutcomeKind = "error" | "rejected" | "provisioning" | "interrupted" | "completed";
export type Outcome = { kind: OutcomeKind; summary: string; detail: string };

export const OUTCOME_DETAIL_MAX = 2000;
/** How many recent events the summariser reads. */
export const OUTCOME_EVENT_WINDOW = 50;

const OUTCOME_EVENT_TYPES = [
  "provider/error",
  "system/error",
  "client/turn/rejected",
  "system/thread-provisioning",
  "system/thread/interrupted",
  "turn/completed",
] as const;

// A stack trace starts at the first of these. Everything after it is dropped.
const STACK_MARKERS = [/\n\s+at\s/, /Traceback \(most recent call last\)/, /Stack trace:/i];

/** Cut text before the first stack-trace marker, then cap it. */
export function clipDetail(text: string, max: number = OUTCOME_DETAIL_MAX): string {
  let end = text.length;
  for (const marker of STACK_MARKERS) {
    const found = marker.exec(text);
    if (found && found.index < end) end = found.index;
  }
  const clipped = text.slice(0, end).trim();
  return clipped.length > max ? `${clipped.slice(0, max - 1).trimEnd()}…` : clipped;
}

const firstLine = (text: string): string => text.split("\n")[0]!.trim();

const INTERRUPT_REASONS: Record<string, string> = {
  "manual-stop": "Someone stopped the thread.",
  "host-daemon-restarted": "The machine's BB host restarted while the thread was working.",
  "host-removed": "The machine was removed from BB while the thread was working.",
  "provider-turn-idle": "The provider went idle and the turn did not finish.",
};

const PROVISIONING_STATES: Record<string, string> = {
  active: "is still being set up",
  cancelled: "setup was cancelled",
  completed: "setup finished",
  failed: "setup failed",
};

type Data = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function summariseEvent(event: ThreadEventRow, errorsOnly: boolean): Outcome | null {
  const data = (event.data ?? {}) as Data;
  switch (event.type) {
    case "provider/error":
    case "system/error": {
      const message = text(data.message) || "The thread hit an error.";
      const detail = clipDetail([message, text(data.detail)].filter(Boolean).join("\n"));
      return { kind: "error", summary: firstLine(clipDetail(message, 300)), detail };
    }
    case "client/turn/rejected": {
      const reason = text(data.reason) || "rejected";
      const message = text(data.message);
      return { kind: "rejected", summary: `The message was not accepted: ${message || reason}.`, detail: clipDetail(message || reason) };
    }
    case "system/thread-provisioning": {
      const status = text(data.status);
      if (errorsOnly && status !== "failed") return null;
      const entries = Array.isArray(data.entries) ? (data.entries as Data[]) : [];
      const failed = entries.find((entry) => entry.status === "failed");
      const latest = failed ?? entries.at(-1);
      const stage = latest ? text(latest.text) : "";
      const state = PROVISIONING_STATES[status] ?? "is being set up";
      const summary = `The thread's environment ${state}${stage ? ` (${firstLine(stage)})` : ""}.`;
      return { kind: "provisioning", summary, detail: clipDetail(stage || summary) };
    }
    case "system/thread/interrupted": {
      const reason = text(data.reason);
      const human =
        data.cause === "host-connection-lost"
          ? "The connection to the machine was lost while the thread was working."
          : (INTERRUPT_REASONS[reason] ?? "The thread was interrupted.");
      return { kind: "interrupted", summary: human, detail: reason || human };
    }
    case "turn/completed": {
      const status = text(data.status);
      const errorMessage = typeof data.error === "object" && data.error !== null ? text((data.error as Data).message) : "";
      if (status === "failed") {
        const message = errorMessage || "The turn failed.";
        return { kind: "error", summary: firstLine(clipDetail(message, 300)), detail: clipDetail(message) };
      }
      if (status === "interrupted") {
        return { kind: "interrupted", summary: "The turn was interrupted before it finished.", detail: errorMessage || "interrupted" };
      }
      if (errorsOnly) return null;
      return { kind: "completed", summary: "finished without a message", detail: "" };
    }
    default:
      return null;
  }
}

/** Newest relevant entry from events listed newest first. `errorsOnly` skips plain completions. */
export function summariseEvents(events: readonly ThreadEventRow[], options: { errorsOnly?: boolean } = {}): Outcome | null {
  for (const event of events) {
    const outcome = summariseEvent(event, options.errorsOnly === true);
    if (outcome) return outcome;
  }
  return null;
}

/** Read the thread's recent events and summarise them. */
export async function threadOutcome(ctx: ServerContext, threadId: string, options: { errorsOnly?: boolean } = {}): Promise<Outcome | null> {
  const events = await ctx.bb.sdk.threads.events.list({
    threadId,
    order: "desc",
    limit: String(OUTCOME_EVENT_WINDOW),
    types: [...OUTCOME_EVENT_TYPES],
  });
  return summariseEvents(events, options);
}
