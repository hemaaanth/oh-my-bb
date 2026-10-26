// Pre-flight for the review/text-edit child spawn.
//
// A saved agent profile pins a provider and a model. When the account behind
// that provider is rate limited, every turn the child runs dies instantly with
// a provider error and the thread still looks perfectly healthy: it exists, its
// status is idle, and the turn that failed is recorded as "completed". Pinpoint
// used to notice none of that and kept feeding pins into a thread that could
// not act on them. This module reads the provider-usage snapshot BEFORE the
// spawn so a known-blocked provider never gets the work in the first place.
//
// The rule throughout is FAIL OPEN. A verdict of "blocked" suppresses a spawn
// the user configured, so we only return one when the snapshot definitively
// says so. Anything unknown — no host, machine not listed, machine offline, no
// usage for that provider, a usage probe that itself errored — is `ok`, and
// lib/delivery-check.ts catches whatever slips through.

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export type ProviderUsage =
  | { status: "ok"; planLabel?: string | null; windows: UsageWindow[] }
  | { status: "not_installed" }
  | { status: "unauthenticated" }
  | { status: "expired" }
  | { status: "error"; message: string };

export interface UsageProvider {
  id: string;
  displayName?: string;
  usage: ProviderUsage | null;
}

export interface UsageMachine {
  id: string;
  status: "connected" | "disconnected";
  providers: UsageProvider[];
}

export type HealthVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Providers whose id is not itself a usage key. An ACP provider multiplexes
 * several vendors behind one id (`acp-omp` serves both `openai-codex/...` and
 * `wafer-serverless/...` models), so the model's vendor prefix — not the
 * provider id — says which account actually pays for the turn. Only vendors
 * that map onto a first-party usage entry appear here; an unlisted vendor has
 * no usage to read and therefore never blocks.
 */
const USAGE_KEY_BY_MODEL_VENDOR: Record<string, string> = {
  "openai-codex": "codex",
  codex: "codex",
  anthropic: "claude-code",
  claude: "claude-code",
};

/** Usage entries that could be paying for `providerId` running `model`. */
export function usageKeysFor(providerId: string, model: string): string[] {
  const keys = new Set<string>();
  if (providerId) keys.add(providerId);
  const vendor = model.includes("/") ? model.split("/", 1)[0]! : "";
  const mapped = USAGE_KEY_BY_MODEL_VENDOR[vendor.toLowerCase()];
  if (mapped) keys.add(mapped);
  return [...keys];
}

function blockedReason(
  provider: UsageProvider,
): string | null {
  const usage = provider.usage;
  if (!usage) return null;
  const name = provider.displayName || provider.id;
  switch (usage.status) {
    case "not_installed":
      return `${name} is not installed on this machine`;
    case "unauthenticated":
      return `${name} is not signed in on this machine`;
    case "expired":
      return `the ${name} session on this machine has expired`;
    case "error":
      // The probe failed, which says nothing about the account itself.
      return null;
    case "ok": {
      const exhausted = usage.windows.find(
        (window) => window.usedPercent >= 100,
      );
      if (!exhausted) return null;
      const resets = exhausted.resetsAt
        ? `, resets ${exhausted.resetsAt}`
        : "";
      return `${name} has exhausted its ${exhausted.label.toLowerCase()}${resets}`;
    }
  }
}

/**
 * Is the account behind this profile able to run a turn right now? `machines`
 * is the provider-usage snapshot; `hostId` is the machine the child would run
 * on. See the fail-open note at the top of this file.
 */
export function checkProviderHealth(input: {
  providerId: string;
  model: string;
  hostId: string | null;
  machines: readonly UsageMachine[];
}): HealthVerdict {
  if (!input.hostId) return { ok: true };
  const machine = input.machines.find((entry) => entry.id === input.hostId);
  if (!machine || machine.status !== "connected") return { ok: true };
  const keys = usageKeysFor(input.providerId, input.model);
  for (const provider of machine.providers) {
    if (!keys.includes(provider.id)) continue;
    const reason = blockedReason(provider);
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}
