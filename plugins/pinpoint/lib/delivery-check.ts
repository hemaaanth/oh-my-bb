// Did the thread we handed a pin to actually DO anything with it?
//
// `bb.sdk.threads.send` resolving means the message was accepted, not that an
// agent acted on it. A child whose provider is rate limited accepts the send,
// runs a turn, emits one agent message saying it is out of quota, and records
// the turn as `turn/completed` with status "completed". Nothing in the thread's
// status, and nothing in the send's return value, distinguishes that from real
// work — so delivery has to be judged from what the turn PRODUCED.
//
// The signal is item types. A turn that only reasons and talks changed nothing;
// a turn that ran a command, read or wrote a file, or searched did. Inert types
// are listed rather than productive ones so an item type we have never seen
// counts as work and the item is left alone: a missed stall is recoverable by
// the user, a false stall would yank a pin away from an agent mid-edit.

/** Item types that mean the agent talked or thought, not that it acted. */
export const INERT_ITEM_TYPES = ["agentMessage", "reasoning"] as const;

export interface DeliveryEvent {
  type: string;
  data?: {
    item?: { type?: string; text?: string } | null;
  } | null;
}

export type DeliveryVerdict =
  | { kind: "acted" }
  | { kind: "stalled"; detail: string };

const STALL_DETAIL_LIMIT = 400;

function itemOf(event: DeliveryEvent): { type?: string; text?: string } | null {
  return event.data?.item ?? null;
}

/**
 * Classify the events a thread emitted after we sent it a pin. `events` must
 * be the window from the send onward, in sequence order.
 */
export function classifyDelivery(
  events: readonly DeliveryEvent[],
): DeliveryVerdict {
  let startedTurn = false;
  let lastMessage = "";
  for (const event of events) {
    if (event.type === "turn/started") startedTurn = true;
    const item = itemOf(event);
    const itemType = item?.type;
    if (!itemType) continue;
    if (!(INERT_ITEM_TYPES as readonly string[]).includes(itemType)) {
      return { kind: "acted" };
    }
    if (itemType === "agentMessage" && item?.text) lastMessage = item.text;
  }
  if (!startedTurn) {
    return {
      kind: "stalled",
      detail: "the thread never started a turn on this item",
    };
  }
  return {
    kind: "stalled",
    detail: lastMessage
      ? `the thread ran a turn without doing any work: ${truncate(lastMessage)}`
      : "the thread ran a turn without doing any work",
  };
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > STALL_DETAIL_LIMIT
    ? `${flat.slice(0, STALL_DETAIL_LIMIT - 1)}…`
    : flat;
}
