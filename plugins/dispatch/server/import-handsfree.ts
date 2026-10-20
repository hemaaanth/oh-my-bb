// One-time import from the earlier voice plugin, `handsfree` (SPEC §17).
// Owned by P4. Every read is read-only and nothing in the old plugin changes.
// No secret value is ever returned, logged, or put in an error message.
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { CLIENT_TRACE_KINDS, SERVER_TRACE_KINDS, type DeviceProfile, type ImportMarker, type ImportReport } from "../shared/contract.js";
import {
  CHANNELS,
  DEFAULT_AGENT_NAME,
  KV_KEYS,
  REASONING_MODELS,
  SECRET_IDS,
  SETUP_LABELS,
  VOICES,
  VOICE_MODELS,
  AGENT_NAME_MAX,
  defaultPreferences,
  type SecretId,
} from "../shared/constants.js";
import type { Preferences } from "../shared/contract.js";
import { checkHotkey } from "../app/settings/hotkey.js";
import type { ServerContext } from "./context.js";
import { SETUP_FORMATS } from "./settings.js";

export const OLD_PLUGIN_ID = "handsfree";
const OLD_CONFIG_KEY = "config";

/** Old secret file name → new setting id (SPEC §17 step 3). */
export const SECRET_FILES: Readonly<Record<string, SecretId>> = {
  openaiApiKey: "openaiKey",
  twilioAccountSid: "twilioSid",
  twilioAuthToken: "twilioToken",
  twilioFromNumber: "twilioCallerNumber",
  destinationNumber: "yourPhoneNumber",
  openaiSipProjectId: "openaiSipProject",
};

/** Where the old plugin keeps things. Tests point these at fixtures. */
export type ImportSource = {
  /** The old plugin's `config` value as parsed JSON, or undefined when there is none. */
  readConfig(): unknown;
  /** The text of one old secret file, or null when the file is missing. */
  readSecret(fileName: string): string | null;
  /** Path of the old plugin's `data.db`. */
  historyDbPath: string;
};

export type ImportOptions = { dryRun: boolean; includeLegacyUsage: boolean };

/** The real locations: BB's `bb.db`, and the old plugin's own folder under the data directory. */
export function liveSource(ctx: ServerContext): ImportSource {
  const dataDir = ctx.bb.server.experimental_dataDir;
  const pluginDir = path.join(dataDir, "plugins", OLD_PLUGIN_ID);
  const Sqlite = sqliteClass(ctx);
  return {
    readConfig() {
      const dbPath = path.join(dataDir, "bb.db");
      if (!fs.existsSync(dbPath)) return undefined;
      const db = new Sqlite(dbPath, { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare("SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?").get(OLD_PLUGIN_ID, OLD_CONFIG_KEY) as
          | { value: string }
          | undefined;
        return row ? (JSON.parse(row.value) as unknown) : undefined;
      } finally {
        db.close();
      }
    },
    readSecret(fileName) {
      try {
        return fs.readFileSync(path.join(pluginDir, "secrets", fileName), "utf8");
      } catch {
        return null;
      }
    },
    historyDbPath: path.join(pluginDir, "data.db"),
  };
}

/** bb does not serve better-sqlite3 to plugins. The open handle carries the class. */
function sqliteClass(ctx: ServerContext): typeof Database {
  return ctx.db.constructor as typeof Database;
}

// ---------------------------------------------------------------------------
// Preferences

type PrefsResult = { prefs: Preferences; imported: string[]; dropped: string[]; defaulted: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Map the old `config` onto Dispatch preferences, field by field (SPEC §17 step 2). */
export function mapConfig(config: unknown, base: Preferences = defaultPreferences()): PrefsResult {
  const prefs = base;
  const imported: string[] = [];
  const dropped: string[] = [];
  const defaulted: string[] = [];
  if (!isRecord(config)) return { prefs, imported, dropped, defaulted };
  const defaults = defaultPreferences();
  const present = (obj: Record<string, unknown>, key: string) => obj[key] !== undefined && obj[key] !== null;

  // `value` is the cleaned old value, or undefined when the old one was unusable.
  // An unusable value puts the default back and is listed as defaulted.
  const field = <T>(name: string, oldPresent: boolean, value: T | undefined, apply: (value: T) => void, fallback: () => void) => {
    if (!oldPresent) return;
    if (value !== undefined) {
      apply(value);
      imported.push(name);
    } else {
      fallback();
      defaulted.push(name);
    }
  };

  const name = typeof config.assistantName === "string" ? config.assistantName.trim().slice(0, AGENT_NAME_MAX) : "";
  field("agentName", present(config, "assistantName"), name || undefined, (v) => (prefs.agentName = v), () => (prefs.agentName = defaults.agentName));
  field("voice", present(config, "voice"), oneOf(VOICES, config.voice), (v) => (prefs.voice = v), () => (prefs.voice = defaults.voice));
  field("voiceModel", present(config, "model"), oneOf(VOICE_MODELS, config.model), (v) => (prefs.voiceModel = v), () => (prefs.voiceModel = defaults.voiceModel));
  field("reasoningModel", present(config, "backendModel"), oneOf(REASONING_MODELS, config.backendModel), (v) => (prefs.reasoningModel = v), () => (prefs.reasoningModel = defaults.reasoningModel));
  field(
    "announcements",
    present(config, "notifications"),
    typeof config.notifications === "boolean" ? config.notifications : undefined,
    (v) => (prefs.announcements = v),
    () => (prefs.announcements = defaults.announcements),
  );
  field(
    "mobileDrawerBehavior",
    present(config, "mobileViewBehavior"),
    oneOf(["reuse", "new"] as const, config.mobileViewBehavior),
    (v) => (prefs.mobileDrawerBehavior = v),
    () => (prefs.mobileDrawerBehavior = defaults.mobileDrawerBehavior),
  );
  field("pluginAccess", present(config, "pluginCommands"), parsePluginAccess(config.pluginCommands), (v) => (prefs.pluginAccess = v), () => (prefs.pluginAccess = defaults.pluginAccess));

  const shortcuts = isRecord(config.shortcuts) ? config.shortcuts : {};
  for (const action of ["toggle", "mute"] as const) {
    const raw = shortcuts[action];
    const checked = typeof raw === "string" ? checkHotkey(raw) : undefined;
    field(`hotkeys.${action}`, present(shortcuts, action), checked?.ok ? checked.combo : undefined, (v) => (prefs.hotkeys[action] = v), () => (prefs.hotkeys[action] = defaults.hotkeys[action]));
  }

  const look = isRecord(config.petLook) ? config.petLook : {};
  const color = typeof look.color === "string" && (look.color === "theme" || HEX_COLOR.test(look.color)) ? look.color : undefined;
  const roundness = typeof look.roundness === "number" && Number.isFinite(look.roundness) ? Math.round(Math.min(100, Math.max(0, look.roundness))) : undefined;
  field("pet.style", present(look, "style"), oneOf(["outline", "solid"] as const, look.style), (v) => (prefs.pet.style = v), () => (prefs.pet.style = defaults.pet.style));
  field("pet.color", present(look, "color"), color, (v) => (prefs.pet.color = v), () => (prefs.pet.color = defaults.pet.color));
  field("pet.roundness", present(look, "roundness"), roundness, (v) => (prefs.pet.roundness = v), () => (prefs.pet.roundness = defaults.pet.roundness));
  field(
    "pet.followPointer",
    present(look, "followPointer"),
    typeof look.followPointer === "boolean" ? look.followPointer : undefined,
    (v) => (prefs.pet.followPointer = v),
    () => (prefs.pet.followPointer = defaults.pet.followPointer),
  );
  field(
    "pet.antennaFlash",
    present(look, "antennaFlash"),
    typeof look.antennaFlash === "boolean" ? look.antennaFlash : undefined,
    (v) => (prefs.pet.antennaFlash = v),
    () => (prefs.pet.antennaFlash = defaults.pet.antennaFlash),
  );

  // Dispatch has no subscription path, so this choice has nowhere to go.
  if (present(config, "credentialPreference")) dropped.push("credentialPreference");
  return { prefs, imported, dropped, defaulted };
}

/** `all`, `none`, or a comma list of plugin ids. An empty list is not usable. */
function parsePluginAccess(raw: unknown): Preferences["pluginAccess"] | undefined {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (typeof raw === "string") {
    const word = raw.trim().toLowerCase();
    if (word === "all") return { mode: "all" };
    if (word === "none") return { mode: "none" };
  }
  if (!items) return undefined;
  const ids = [...new Set(items.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  return ids.length > 0 ? { mode: "selected", ids } : undefined;
}

// ---------------------------------------------------------------------------
// Secrets

type SecretPlan = { status: ImportReport["secrets"]; values: Partial<Record<SecretId, string>> };

/** Read every old secret file. The values stay in `values`; only statuses go in the report. */
function planSecrets(source: ImportSource): SecretPlan {
  const status = Object.fromEntries(SECRET_IDS.map((id) => [id, "absent"])) as ImportReport["secrets"];
  const values: Partial<Record<SecretId, string>> = {};
  for (const [fileName, id] of Object.entries(SECRET_FILES)) {
    const text = source.readSecret(fileName)?.trim();
    if (!text) continue;
    if (SETUP_FORMATS[id].safeParse(text).success) {
      status[id] = "copied";
      values[id] = text;
    } else {
      status[id] = "invalid";
    }
  }
  return { status, values };
}

// ---------------------------------------------------------------------------
// History (data.db)

const COLUMNS = {
  sessionId: ["session_id", "sessionId"],
  kind: ["kind", "type", "event", "event_type", "name"],
  payload: ["payload", "payload_json", "data", "details", "detail"],
  at: ["at", "ts", "timestamp", "created_at", "occurred_at", "time"],
};
const pick = (columns: Set<string>, candidates: string[]) => candidates.find((name) => columns.has(name));

const KNOWN_KINDS = new Set<string>([...SERVER_TRACE_KINDS, ...CLIENT_TRACE_KINDS]);
const KIND_MAP: Record<string, string> = {
  "session.started": "call.started",
  "session.stopped": "call.stopped",
  "session.closed": "call.closed",
};
const mapKind = (old: string) => KIND_MAP[old] ?? (KNOWN_KINDS.has(old) ? old : `legacy.${old}`);

/** Old timestamps may be epoch seconds, epoch milliseconds, or ISO text. */
function toMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toMillis(numeric);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function parsePayload(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value === "" ? null : { value };
    }
  }
  if (parsed === null || parsed === undefined) return null;
  return isRecord(parsed) ? parsed : { value: parsed };
}

type OldEvent = { sessionId: string; kind: string; at: number; payload: Record<string, unknown> | null };
type PlannedCall = {
  id: string;
  channel: "app" | "phone";
  device: DeviceProfile;
  startedAt: number;
  endedAt: number;
  closeReason: string | null;
  billedSeconds: number;
  unclean: boolean;
  events: Array<{ at: number; kind: string; payload: Record<string, unknown> | null }>;
};

const RUNTIMES = ["browser", "pwa", "native-webview", "sip"] as const;

function deviceFrom(payload: Record<string, unknown> | null): { device: DeviceProfile; channel: "app" | "phone" } {
  const raw = isRecord(payload?.device) ? payload.device : {};
  const runtime = oneOf(RUNTIMES, raw.runtime ?? payload?.runtime) ?? "browser";
  const channel = runtime === "sip" ? "phone" : "app";
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() !== "" ? value : fallback);
  return {
    channel,
    device: {
      platform: text(raw.platform, "unknown"),
      mobile: typeof raw.mobile === "boolean" ? raw.mobile : false,
      browser: text(raw.browser, "unknown"),
      displayMode: text(raw.displayMode, "browser"),
      runtime,
      label: text(raw.label, channel === "phone" ? "Phone call" : "Earlier voice plugin"),
    },
  };
}

function groupSessions(events: OldEvent[]): PlannedCall[] {
  const bySession = new Map<string, OldEvent[]>();
  for (const event of events) {
    const list = bySession.get(event.sessionId);
    if (list) list.push(event);
    else bySession.set(event.sessionId, [event]);
  }
  const calls: PlannedCall[] = [];
  for (const [sessionId, list] of bySession) {
    const first = list[0]!;
    const started = list.find((event) => event.kind === "session.started");
    const { device, channel } = deviceFrom(started?.payload ?? null);
    const stops = list.filter((event) => event.kind === "session.stopped" || event.kind === "session.closed");
    const last = stops.at(-1);
    const usage = list.filter((event) => event.kind === "usage.seconds").at(-1);
    const seconds = usage?.payload ? Number(usage.payload.seconds ?? usage.payload.total ?? usage.payload.value) : 0;
    const reason = last?.payload?.reason;
    calls.push({
      id: `handsfree-${sessionId}`,
      channel,
      device,
      startedAt: first.at,
      // A session with no stop event ended where its trace does.
      endedAt: last?.at ?? list.at(-1)!.at,
      closeReason: typeof reason === "string" ? reason : null,
      billedSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
      unclean: last === undefined,
      events: list.map((event) => ({ at: event.at, kind: mapKind(event.kind), payload: event.payload })),
    });
  }
  return calls;
}

type History = {
  found: boolean;
  hasPromptVersions: boolean;
  calls: PlannedCall[];
  usageRows: string[];
  notes: string[];
};

function readHistory(Sqlite: typeof Database, dbPath: string): History {
  const empty: History = { found: false, hasPromptVersions: false, calls: [], usageRows: [], notes: [] };
  if (!fs.existsSync(dbPath)) return empty;
  const db = new Sqlite(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    const result: History = { ...empty, found: true };
    if (tables.has("prompt_versions")) {
      result.hasPromptVersions = (db.prepare("SELECT COUNT(*) AS n FROM prompt_versions").get() as { n: number }).n > 0;
    }
    if (tables.has("session_events")) {
      const columns = new Set((db.prepare("PRAGMA table_info(session_events)").all() as Array<{ name: string }>).map((row) => row.name));
      const sid = pick(columns, COLUMNS.sessionId);
      const kind = pick(columns, COLUMNS.kind);
      const at = pick(columns, COLUMNS.at);
      const payload = pick(columns, COLUMNS.payload);
      if (sid && kind && at) {
        const rows = db.prepare(`SELECT "${sid}" AS sid, "${kind}" AS kind, "${at}" AS at, ${payload ? `"${payload}"` : "NULL"} AS payload FROM session_events ORDER BY rowid`).all() as Array<Record<string, unknown>>;
        const events: OldEvent[] = [];
        let unreadable = 0;
        for (const row of rows) {
          const when = toMillis(row.at);
          if (when === null || typeof row.kind !== "string" || row.sid === null || row.sid === undefined) {
            unreadable += 1;
            continue;
          }
          events.push({ sessionId: String(row.sid), kind: row.kind, at: when, payload: parsePayload(row.payload) });
        }
        // Stable sort keeps rowid order for events with the same time.
        events.sort((a, b) => a.at - b.at);
        result.calls = groupSessions(events);
        if (unreadable > 0) result.notes.push(`${unreadable} earlier trace rows had no usable time, kind or session and were skipped.`);
      } else {
        result.notes.push("The earlier trace table has an unexpected shape, so no calls were imported.");
      }
    }
    if (tables.has("usage_events")) {
      result.usageRows = (db.prepare("SELECT * FROM usage_events ORDER BY rowid").all() as Array<Record<string, unknown>>).map((row) =>
        JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? Number(value) : value)),
      );
    }
    return result;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The import

/** What the revision says. Written for this import; the old prompt text is not carried. */
export const IMPORTED_INSTRUCTIONS =
  "Do not fill the silence before acting. Act first, then report what happened.";
export const IMPORTED_INSTRUCTIONS_NOTE = "imported from Handsfree: no filler before acting; act, then report";

export class ImportError extends Error {}

export async function runHandsfreeImport(ctx: ServerContext, options: ImportOptions, source: ImportSource = liveSource(ctx)): Promise<ImportReport> {
  const kv = ctx.bb.storage.kv;
  const marker = await kv.get<ImportMarker>(KV_KEYS.importHandsfree);
  if (marker) {
    throw new ImportError(
      `The Handsfree import already ran on ${new Date(marker.at).toISOString()}. There is no --force. To run it again, delete the "${KV_KEYS.importHandsfree}" key from Dispatch storage by hand.`,
    );
  }

  const stored = await kv.get<Preferences>(KV_KEYS.preferences);
  const mapped = mapConfig(source.readConfig(), stored ? mergeStored(stored) : defaultPreferences());
  const secrets = planSecrets(source);
  const history = readHistory(sqliteClass(ctx), source.historyDbPath);

  const skipped: string[] = [];
  if (!history.found) skipped.push("No earlier history database was found, so no calls or instructions were imported.");
  skipped.push(...history.notes);
  if (!options.includeLegacyUsage && history.usageRows.length > 0) {
    skipped.push(`Legacy token usage skipped (${history.usageRows.length} rows). Pass --include-legacy-usage to copy it.`);
  }
  const copyUsage = options.includeLegacyUsage ? history.usageRows : [];
  const instructions: 0 | 1 = history.hasPromptVersions ? 1 : 0;

  const report: ImportReport = {
    dryRun: options.dryRun,
    preferences: { imported: mapped.imported, dropped: mapped.dropped, defaulted: mapped.defaulted },
    secrets: secrets.status,
    instructions: { imported: instructions },
    calls: history.calls.length,
    traceEvents: history.calls.reduce((total, call) => total + call.events.length, 0),
    legacyTokenRows: copyUsage.length,
    skipped,
  };
  if (options.dryRun) return report;

  const now = Date.now();
  // History goes in one transaction. Call ids come from the old session ids,
  // so a run that stopped half way cannot add a call twice.
  const db = ctx.db;
  let revision: { id: number; at: number; author: "import"; note: string; body: string } | null = null;
  db.transaction(() => {
    const insertCall = db.prepare(
      `INSERT OR IGNORE INTO calls (id, channel, device_json, started_at, ended_at, close_reason, billed_seconds, unclean) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTrace = db.prepare("INSERT INTO call_trace (call_id, at, kind, payload_json) VALUES (?, ?, ?, ?)");
    for (const call of history.calls) {
      const inserted = insertCall.run(call.id, call.channel, JSON.stringify(call.device), call.startedAt, call.endedAt, call.closeReason, call.billedSeconds, call.unclean ? 1 : 0);
      if (inserted.changes === 0) continue;
      for (const event of call.events) insertTrace.run(call.id, event.at, event.kind, event.payload ? JSON.stringify(event.payload) : null);
    }
    if (instructions === 1) {
      const existing = db.prepare("SELECT COUNT(*) AS n FROM instruction_revisions WHERE author = 'import'").get() as { n: number };
      if (existing.n === 0) {
        const info = db
          .prepare("INSERT INTO instruction_revisions (at, author, note, body) VALUES (?, 'import', ?, ?)")
          .run(now, IMPORTED_INSTRUCTIONS_NOTE, IMPORTED_INSTRUCTIONS);
        revision = { id: Number(info.lastInsertRowid), at: now, author: "import", note: IMPORTED_INSTRUCTIONS_NOTE, body: IMPORTED_INSTRUCTIONS };
      }
    }
    const insertUsage = db.prepare("INSERT INTO legacy_token_usage (row_json, imported_at) VALUES (?, ?)");
    for (const row of copyUsage) insertUsage.run(row, now);
  })();

  await kv.set(KV_KEYS.preferences, mapped.prefs);
  const toWrite = Object.keys(secrets.values).length;
  if (toWrite > 0) {
    try {
      await ctx.settings.experimental_set(secrets.values);
    } catch {
      // The reason could echo a value, so it is not passed on.
      throw new ImportError("BB refused to save the imported setup values. Nothing else was marked as done; fix the values and run the import again.");
    }
  }
  await kv.set(KV_KEYS.importHandsfree, { at: now, report } satisfies ImportMarker);

  ctx.bb.realtime.publish(CHANNELS.preferencesUpdated, mapped.prefs);
  if (revision) ctx.bb.realtime.publish(CHANNELS.instructionsUpdated, revision);
  return report;
}

/** Keep stored preferences when they exist, filling any missing field with its default. */
function mergeStored(stored: Preferences): Preferences {
  const base = defaultPreferences();
  return { ...base, ...stored, hotkeys: { ...base.hotkeys, ...stored.hotkeys }, pet: { ...base.pet, ...stored.pet } };
}

/** The lines the CLI prints. Names and counts only. */
export function describeReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(report.dryRun ? "Dry run. Nothing was written." : "Import done.");
  const list = (items: string[]) => (items.length > 0 ? items.join(", ") : "none");
  lines.push(`Preferences imported: ${list(report.preferences.imported)}`);
  lines.push(`Preferences reset to default: ${list(report.preferences.defaulted)}`);
  lines.push(`Preferences dropped: ${list(report.preferences.dropped)}`);
  lines.push("Setup values:");
  for (const id of SECRET_IDS) lines.push(`  ${SETUP_LABELS[id]}: ${report.secrets[id]}`);
  lines.push(`Instructions revisions: ${report.instructions.imported}`);
  lines.push(`Calls: ${report.calls}`);
  lines.push(`Trace events: ${report.traceEvents}`);
  lines.push(`Legacy token usage rows: ${report.legacyTokenRows}`);
  for (const line of report.skipped) lines.push(`Note: ${line}`);
  if (report.dryRun) lines.push("Run again with --apply to write these changes.");
  return `${lines.join("\n")}\n`;
}
