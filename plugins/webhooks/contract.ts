// Shared wire contract. The server validates every RPC call against these
// schemas; app.tsx imports only the types and the limit constants.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const PLUGIN_ID = "webhooks";
/**
 * The one method a receiver plugin registers, with `experimental_discoverable`,
 * to take deliveries from a "plugin" action. Webhooks never calls another method.
 */
export const RECEIVE_METHOD = "webhooks_receive";
/** The one inbound route. The endpoint id travels in the query string. */
export const DELIVER_ROUTE = "/deliver";
export const DELIVER_PATH = `/api/v1/plugins/${PLUGIN_ID}/http/deliver`;
/** Realtime channel. The payload is `{ endpointId }` and nothing else. */
export const CHANGED_CHANNEL = "webhooks-changed";

export const LIMITS = {
  fields: 24,
  pathSegments: 8,
  pathLength: 256,
  stringMaxLength: 4000,
  stringDefaultMaxLength: 500,
  allowedValues: 50,
  message: 8000,
  title: 200,
  bodyMinBytes: 1024,
  bodyDefaultBytes: 64 * 1024,
  bodyMaxBytes: 1024 * 1024,
  jsonDepth: 32,
  rateDefaultPerMinute: 30,
  rateMaxPerMinute: 600,
  /** Standard Webhooks reference receivers and Slack both use five minutes. */
  timestampToleranceSeconds: 300,
  slackChallenge: 512,
  deliveriesPage: 200,
} as const;

/** Placeholders every template may use besides the declared field names. */
export const BUILTIN_PLACEHOLDERS = ["fields", "endpoint_name", "delivery_id", "received_at"] as const;

export const ENDPOINT_ID = /^wh_[a-f0-9]{24}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_$@-]{1,64}$/;
const TARGET_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export const authModes = ["standard-webhooks", "slack", "bearer"] as const;
export type AuthMode = (typeof authModes)[number];

const targetId = (label: string) =>
  z.string().trim().regex(TARGET_ID, `${label} must be an id made of letters, digits, and _ . : -`);

export const fieldSchema = z
  .object({
    /** The name templates use: `{{name}}`. */
    name: z
      .string()
      .regex(FIELD_NAME, "Field names are lowercase letters, digits, and _, starting with a letter (max 40)."),
    /** Dot path into the JSON body. A numeric segment indexes an array. */
    path: z
      .string()
      .min(1)
      .max(LIMITS.pathLength)
      .refine((path) => {
        const segments = path.split(".");
        return segments.length <= LIMITS.pathSegments && segments.every((segment) => PATH_SEGMENT.test(segment));
      }, `Paths are up to ${LIMITS.pathSegments} dot-separated segments of letters, digits, and _ $ @ -.`),
    type: z.enum(["string", "number", "integer", "boolean"]),
    required: z.boolean().default(false),
    /** Strings only. Longer values are rejected, not cut. */
    maxLength: z.number().int().min(1).max(LIMITS.stringMaxLength).optional(),
    /** Strings only. When set, the value must be one of these. */
    allowed: z.array(z.string().min(1).max(200)).min(1).max(LIMITS.allowedValues).optional(),
  })
  .strict();
export type FieldSpec = z.infer<typeof fieldSchema>;

export const environmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-default") }).strict(),
  z.object({ type: z.literal("reuse"), environmentId: targetId("environmentId") }).strict(),
  z
    .object({
      type: z.literal("worktree"),
      hostId: targetId("hostId").optional(),
      baseBranch: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("provider"),
      environmentProviderId: targetId("environmentProviderId"),
      /** Fixed provider inputs. Payload values never reach them. */
      inputs: z
        .record(z.string().min(1).max(100), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
        .refine((inputs) => Object.keys(inputs).length <= 50, "At most 50 provider inputs.")
        .default({}),
    })
    .strict(),
]);
export type EnvironmentSpec = z.infer<typeof environmentSchema>;

const messageTemplate = z.string().trim().min(1).max(LIMITS.message);

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send"), threadId: targetId("threadId"), message: messageTemplate }).strict(),
  z
    .object({
      type: z.literal("spawn"),
      projectId: targetId("projectId"),
      environment: environmentSchema.default({ type: "project-default" }),
      title: z.string().trim().min(1).max(LIMITS.title).optional(),
      message: messageTemplate,
    })
    .strict(),
  z
    .object({ type: z.literal("automation"), projectId: targetId("projectId"), automationId: targetId("automationId") })
    .strict(),
  /** Hands the declared field values to another plugin's `webhooks_receive` method. */
  z.object({ type: z.literal("plugin"), pluginId: targetId("pluginId") }).strict(),
]);
export type ActionSpec = z.infer<typeof actionSchema>;

export const dedupeSchema = z.discriminatedUnion("source", [
  /** The Standard Webhooks `webhook-id` header. Stable across sender retries. */
  z.object({ source: z.literal("webhook-id") }).strict(),
  /** A declared, required string or integer field. */
  z.object({ source: z.literal("field"), field: z.string().regex(FIELD_NAME) }).strict(),
  /** SHA-256 of the raw body. Only safe when the body has no per-attempt values. */
  z.object({ source: z.literal("body-hash") }).strict(),
]);
export type DedupeSpec = z.infer<typeof dedupeSchema>;

/** Placeholder names a template references, in order of first use. */
export function templatePlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) names.add(match[1]!);
  return [...names];
}

export const endpointConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    authMode: z.enum(authModes),
    maxBodyBytes: z.number().int().min(LIMITS.bodyMinBytes).max(LIMITS.bodyMaxBytes).default(LIMITS.bodyDefaultBytes),
    rateLimitPerMinute: z.number().int().min(1).max(LIMITS.rateMaxPerMinute).default(LIMITS.rateDefaultPerMinute),
    fields: z.array(fieldSchema).max(LIMITS.fields).default([]),
    dedupe: dedupeSchema,
    action: actionSchema,
  })
  .strict()
  .superRefine((config, ctx) => {
    const declared = new Map<string, FieldSpec>();
    config.fields.forEach((field, index) => {
      if (declared.has(field.name)) ctx.addIssue({ code: "custom", path: ["fields", index, "name"], message: `Field ${field.name} is declared twice.` });
      if ((BUILTIN_PLACEHOLDERS as readonly string[]).includes(field.name)) {
        ctx.addIssue({ code: "custom", path: ["fields", index, "name"], message: `${field.name} is a built-in placeholder name.` });
      }
      if (field.type !== "string" && (field.maxLength !== undefined || field.allowed !== undefined)) {
        ctx.addIssue({ code: "custom", path: ["fields", index], message: "maxLength and allowed apply to string fields only." });
      }
      declared.set(field.name, field);
    });
    if (config.dedupe.source === "webhook-id" && config.authMode !== "standard-webhooks") {
      ctx.addIssue({ code: "custom", path: ["dedupe", "source"], message: "webhook-id dedupe needs the standard-webhooks auth mode." });
    }
    if (config.dedupe.source === "field") {
      const field = declared.get(config.dedupe.field);
      if (field === undefined || !field.required || (field.type !== "string" && field.type !== "integer")) {
        ctx.addIssue({ code: "custom", path: ["dedupe", "field"], message: "The dedupe field must be a declared, required string or integer field." });
      }
    }
    const action = config.action;
    const templates: [string, string][] = action.type === "send" || action.type === "spawn" ? [["message", action.message]] : [];
    if (action.type === "spawn" && action.title !== undefined) templates.push(["title", action.title]);
    for (const [key, template] of templates) {
      for (const name of templatePlaceholders(template)) {
        if (!declared.has(name) && !(BUILTIN_PLACEHOLDERS as readonly string[]).includes(name)) {
          ctx.addIssue({ code: "custom", path: ["action", key], message: `{{${name}}} is not a declared field or built-in placeholder.` });
        }
      }
    }
  });
export type EndpointConfigInput = z.input<typeof endpointConfigSchema>;
export type EndpointConfig = z.output<typeof endpointConfigSchema>;

const endpointViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  authMode: z.enum(authModes),
  /** The last four characters of the secret or token. Never the secret. */
  secretHint: z.string(),
  secretUpdatedAt: z.string(),
  maxBodyBytes: z.number(),
  rateLimitPerMinute: z.number(),
  fields: z.array(fieldSchema),
  dedupe: dedupeSchema,
  action: actionSchema,
  /** The path senders use: `/webhook/<id>` when the webhook listener runs, else the BB deliver route. Prefix it with the public HTTPS origin. */
  deliveryPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Requests rejected before authentication since the plugin loaded. Not persisted. */
  rejectedSinceLoad: z.number(),
  lastRejectedReason: z.string().nullable(),
  lastDelivery: z.object({ status: z.string(), receivedAt: z.string() }).nullable(),
});
export type EndpointView = z.infer<typeof endpointViewSchema>;

export const deliveryStatuses = ["processing", "succeeded", "failed", "rejected"] as const;
const deliveryViewSchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  status: z.enum(deliveryStatuses),
  attempts: z.number(),
  duplicates: z.number(),
  actionType: z.string(),
  threadId: z.string().nullable(),
  automationRunId: z.string().nullable(),
  automationRunStatus: z.string().nullable(),
  error: z.string().nullable(),
  receivedAt: z.string(),
  updatedAt: z.string(),
});
export type DeliveryView = z.infer<typeof deliveryViewSchema>;

const endpointIdInput = z.object({ endpointId: z.string().regex(ENDPOINT_ID, "Unknown endpoint id.") }).strict();
/** A secret supplied by the caller instead of a generated one. */
const importedSecret = z.string().min(1).max(512).optional();
const jsonValue: z.ZodType<unknown> = z.json();

export const rpcContract = defineRpcContract({
  webhooks_overview: {
    input: z.null(),
    output: z.object({
      endpoints: z.array(endpointViewSchema),
      deliverPath: z.string(),
      /** From the plugin's `publicBaseUrl` setting, else BB_APP_URL, else null. */
      publicBaseUrl: z.string().nullable(),
    }),
  },
  webhooks_get: {
    input: endpointIdInput,
    output: z.object({ endpoint: endpointViewSchema, deliveries: z.array(deliveryViewSchema) }),
  },
  webhooks_create: {
    input: z.object({ config: z.unknown(), secret: importedSecret }).strict(),
    /** `secret` is shown once: the plugin cannot return it again. Null when imported. */
    output: z.object({ endpoint: endpointViewSchema, secret: z.string().nullable() }),
  },
  webhooks_update: {
    /** `secret` applies only when the auth mode changes. Slack needs it then. */
    input: z.object({ endpointId: z.string().regex(ENDPOINT_ID), config: z.unknown(), secret: importedSecret }).strict(),
    /** A changed auth mode issues a new secret, returned once. Null when imported. */
    output: z.object({ endpoint: endpointViewSchema, secret: z.string().nullable() }),
  },
  webhooks_set_enabled: {
    input: z.object({ endpointId: z.string().regex(ENDPOINT_ID), enabled: z.boolean() }).strict(),
    output: z.object({ endpoint: endpointViewSchema }),
  },
  webhooks_delete: {
    input: endpointIdInput,
    output: z.object({ deleted: z.boolean() }),
  },
  webhooks_rotate_secret: {
    input: z.object({ endpointId: z.string().regex(ENDPOINT_ID), secret: importedSecret }).strict(),
    output: z.object({ endpoint: endpointViewSchema, secret: z.string().nullable() }),
  },
  webhooks_deliveries: {
    input: z
      .object({ endpointId: z.string().regex(ENDPOINT_ID), limit: z.number().int().min(1).max(LIMITS.deliveriesPage).default(50) })
      .strict(),
    output: z.object({ deliveries: z.array(deliveryViewSchema) }),
  },
  webhooks_test: {
    /** Signs `payload` with the stored secret (standard-webhooks or slack) and posts it as JSON to this server's own route. Runs the real action. */
    input: z.object({ endpointId: z.string().regex(ENDPOINT_ID), payload: jsonValue }).strict(),
    output: z.object({ status: z.number(), body: jsonValue }),
  },
  webhooks_targets: {
    input: z.object({ projectId: z.string().regex(TARGET_ID).optional() }).strict(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
      automations: z.object({
        available: z.boolean(),
        items: z.array(z.object({ id: z.string(), name: z.string() })),
        message: z.string().nullable(),
      }),
      /** Plugins that publish a discoverable `webhooks_receive` method. */
      receivers: z.array(z.object({ pluginId: z.string(), name: z.string(), description: z.string().nullable() })),
    }),
  },
});

/**
 * What a "plugin" action sends to the receiver's `webhooks_receive` method.
 * Receivers should check `experimental_caller` is the `webhooks` plugin and
 * treat `fields` as untrusted data. `idempotencyKey` is the same on retries.
 */
export const receiveInputSchema = z.object({
  endpointId: z.string(),
  endpointName: z.string(),
  deliveryId: z.string(),
  receivedAt: z.string(),
  idempotencyKey: z.string(),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type ReceiveInput = z.infer<typeof receiveInputSchema>;
/** A receiver may name a thread it started or messaged; the delivery links to it. */
export const receiveOutputSchema = z.looseObject({ threadId: z.string().optional() });
export type RpcContract = typeof rpcContract;
