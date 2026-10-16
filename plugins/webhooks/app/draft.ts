// The endpoint form's editable state, and its conversion to and from the
// server's endpoint config. The server validates again; this only shapes input.
import type { AuthMode, EndpointConfigInput, EndpointView, FieldSpec } from "../contract.js";

export type FieldDraft = { name: string; path: string; type: FieldSpec["type"]; required: boolean; maxLength: string; allowed: string };
export type Draft = {
  name: string;
  enabled: boolean;
  authMode: AuthMode;
  maxBodyBytes: string;
  rateLimitPerMinute: string;
  fields: FieldDraft[];
  dedupeSource: "webhook-id" | "field" | "body-hash";
  dedupeField: string;
  actionType: "send" | "spawn" | "automation" | "plugin";
  threadId: string;
  projectId: string;
  automationId: string;
  pluginId: string;
  message: string;
  title: string;
  environmentType: "project-default" | "reuse" | "worktree" | "provider";
  environmentId: string;
  hostId: string;
  baseBranch: string;
  environmentProviderId: string;
  /** Kept as JSON text; the form does not edit provider inputs field by field. */
  providerInputs: string;
};

export const DEFAULT_MESSAGE = "A webhook arrived.\n\n{{fields}}";

export const emptyField = (): FieldDraft => ({ name: "", path: "", type: "string", required: false, maxLength: "", allowed: "" });

const text = (name: string, path: string, maxLength: number, required = false): FieldDraft => ({ name, path, type: "string", required, maxLength: String(maxLength), allowed: "" });

/**
 * Field sets for the two Slack request kinds. Each kind has its own Request URL in
 * Slack, so each gets its own endpoint. Events dedupe on `event_id`, which Slack
 * keeps the same on retries. Slash commands dedupe on `trigger_id`, unique per use.
 */
export const SLACK_PRESETS = {
  events: {
    label: "Slack events",
    fields: [
      text("event_id", "event_id", 100, true),
      text("event_type", "event.type", 100, true),
      text("user", "event.user", 100),
      text("channel", "event.channel", 100),
      text("text", "event.text", 4000),
      text("team", "team_id", 100),
    ],
    dedupeField: "event_id",
    message: "Slack {{event_type}} from {{user}} in {{channel}}:\n\n{{text}}",
  },
  command: {
    label: "Slack slash command",
    fields: [
      text("trigger_id", "trigger_id", 200, true),
      text("command", "command", 100, true),
      text("text", "text", 4000),
      text("user", "user_id", 100, true),
      text("channel", "channel_id", 100),
      text("team", "team_id", 100),
    ],
    dedupeField: "trigger_id",
    message: "Slack {{command}} from {{user}} in {{channel}}:\n\n{{text}}",
  },
} as const;

/** Replaces the fields, dedupe, and message with a Slack preset. The action target stays. */
export function withSlackPreset(draft: Draft, kind: keyof typeof SLACK_PRESETS): Draft {
  const preset = SLACK_PRESETS[kind];
  return {
    ...draft,
    authMode: "slack",
    fields: preset.fields.map((field) => ({ ...field })),
    dedupeSource: "field",
    dedupeField: preset.dedupeField,
    message: preset.message,
  };
}

export function newDraft(): Draft {
  return {
    name: "",
    enabled: true,
    authMode: "standard-webhooks",
    maxBodyBytes: "65536",
    rateLimitPerMinute: "30",
    fields: [],
    dedupeSource: "webhook-id",
    dedupeField: "",
    actionType: "send",
    threadId: "",
    projectId: "",
    automationId: "",
    pluginId: "",
    message: DEFAULT_MESSAGE,
    title: "",
    environmentType: "project-default",
    environmentId: "",
    hostId: "",
    baseBranch: "",
    environmentProviderId: "",
    providerInputs: "{}",
  };
}

export function draftFromEndpoint(endpoint: EndpointView): Draft {
  const draft = newDraft();
  const action = endpoint.action;
  const environment = action.type === "spawn" ? action.environment : { type: "project-default" as const };
  return {
    ...draft,
    name: endpoint.name,
    enabled: endpoint.enabled,
    authMode: endpoint.authMode,
    maxBodyBytes: String(endpoint.maxBodyBytes),
    rateLimitPerMinute: String(endpoint.rateLimitPerMinute),
    fields: endpoint.fields.map((field) => ({
      name: field.name,
      path: field.path,
      type: field.type,
      required: field.required,
      maxLength: field.maxLength === undefined ? "" : String(field.maxLength),
      allowed: field.allowed?.join(", ") ?? "",
    })),
    dedupeSource: endpoint.dedupe.source,
    dedupeField: endpoint.dedupe.source === "field" ? endpoint.dedupe.field : "",
    actionType: action.type,
    threadId: action.type === "send" ? action.threadId : "",
    projectId: action.type === "spawn" || action.type === "automation" ? action.projectId : "",
    automationId: action.type === "automation" ? action.automationId : "",
    pluginId: action.type === "plugin" ? action.pluginId : "",
    message: action.type === "send" || action.type === "spawn" ? action.message : DEFAULT_MESSAGE,
    title: action.type === "spawn" ? (action.title ?? "") : "",
    environmentType: environment.type,
    environmentId: environment.type === "reuse" ? environment.environmentId : "",
    hostId: environment.type === "worktree" ? (environment.hostId ?? "") : "",
    baseBranch: environment.type === "worktree" ? (environment.baseBranch ?? "") : "",
    environmentProviderId: environment.type === "provider" ? environment.environmentProviderId : "",
    providerInputs: environment.type === "provider" ? JSON.stringify(environment.inputs ?? {}) : "{}",
  };
}

const optional = (value: string) => (value.trim() ? value.trim() : undefined);
const integer = (value: string) => (value.trim() === "" ? undefined : Number(value));

/** Throws an Error with a readable message when a value cannot be converted at all. */
export function configFromDraft(draft: Draft): EndpointConfigInput {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    authMode: draft.authMode,
    maxBodyBytes: integer(draft.maxBodyBytes),
    rateLimitPerMinute: integer(draft.rateLimitPerMinute),
    fields: draft.fields.map((field) => ({
      name: field.name.trim(),
      path: field.path.trim(),
      type: field.type,
      required: field.required,
      ...(field.type === "string" && field.maxLength.trim() ? { maxLength: Number(field.maxLength) } : {}),
      ...(field.type === "string" && field.allowed.trim()
        ? { allowed: field.allowed.split(",").map((value) => value.trim()).filter(Boolean) }
        : {}),
    })),
    dedupe: draft.dedupeSource === "field" ? { source: "field", field: draft.dedupeField.trim() } : { source: draft.dedupeSource },
    action: actionFromDraft(draft),
  };
}

function actionFromDraft(draft: Draft): EndpointConfigInput["action"] {
  if (draft.actionType === "send") return { type: "send", threadId: draft.threadId.trim(), message: draft.message };
  if (draft.actionType === "automation") return { type: "automation", projectId: draft.projectId.trim(), automationId: draft.automationId.trim() };
  if (draft.actionType === "plugin") return { type: "plugin", pluginId: draft.pluginId.trim() };
  return {
    type: "spawn",
    projectId: draft.projectId.trim(),
    environment: environmentFromDraft(draft),
    ...(optional(draft.title) ? { title: draft.title.trim() } : {}),
    message: draft.message,
  };
}

function environmentFromDraft(draft: Draft) {
  switch (draft.environmentType) {
    case "project-default":
      return { type: "project-default" as const };
    case "reuse":
      return { type: "reuse" as const, environmentId: draft.environmentId.trim() };
    case "worktree":
      return { type: "worktree" as const, ...(optional(draft.hostId) ? { hostId: draft.hostId.trim() } : {}), ...(optional(draft.baseBranch) ? { baseBranch: draft.baseBranch.trim() } : {}) };
    case "provider": {
      let inputs: unknown;
      try {
        inputs = JSON.parse(draft.providerInputs || "{}");
      } catch {
        throw new Error("Provider inputs must be a JSON object.");
      }
      return { type: "provider" as const, environmentProviderId: draft.environmentProviderId.trim(), inputs: inputs as Record<string, string> };
    }
  }
}
