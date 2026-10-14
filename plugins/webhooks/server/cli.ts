// `bb webhooks …`. Secrets print only with --show-secret, so an agent can set
// up an endpoint without the secret entering its transcript.
import { PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError, cliCommand, defineCli, type BbPluginApi, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { DeliveryView, EndpointView } from "../contract.js";
import { InputError, type Service } from "./service.js";

const json = { json: { type: "boolean", description: "Emit machine-readable JSON" } } as const;
const endpointArg = [{ name: "endpoint-id", description: "Endpoint id (wh_…), from `bb webhooks list`", required: true }] as const;
const showSecret = {
  "show-secret": { type: "boolean", description: "Print a newly generated secret. It is shown once and cannot be read again" },
} as const;

function ok(value: unknown, human: string, asJson: boolean | undefined): PluginCliResult {
  const stdout = asJson ? JSON.stringify(value, null, 2) : human;
  if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
    throw new PluginCliError("The output is too large. Use a smaller --limit.", { code: "output_too_large" });
  }
  return { exitCode: 0, stdout };
}

async function attempt(run: () => Promise<PluginCliResult> | PluginCliResult): Promise<PluginCliResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    if (error instanceof InputError) throw new PluginCliError(error.message, { code: "invalid_input" });
    throw error;
  }
}

function parseJson(text: string, option: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PluginCliError(`--${option} is not valid JSON.`, { code: "invalid_json", hint: `Pass JSON inline or with --${option}-stdin.` });
  }
}

const describeAction = (endpoint: EndpointView) => {
  const action = endpoint.action;
  if (action.type === "send") return `send to thread ${action.threadId}`;
  if (action.type === "spawn") return `spawn in project ${action.projectId} (${action.environment.type})`;
  return `run automation ${action.automationId} in project ${action.projectId}`;
};

const endpointLine = (endpoint: EndpointView) =>
  `${endpoint.id}  ${endpoint.enabled ? "on " : "off"}  ${endpoint.authMode.padEnd(17)}  ${endpoint.name} → ${describeAction(endpoint)}${endpoint.lastDelivery ? `  [last: ${endpoint.lastDelivery.status} ${endpoint.lastDelivery.receivedAt}]` : ""}`;

const deliveryLine = (delivery: DeliveryView) =>
  [
    delivery.receivedAt,
    delivery.id,
    delivery.status,
    `attempts=${delivery.attempts}`,
    delivery.duplicates ? `duplicates=${delivery.duplicates}` : null,
    delivery.threadId ? `thread=${delivery.threadId}` : null,
    delivery.automationRunId ? `run=${delivery.automationRunId}(${delivery.automationRunStatus})` : null,
    delivery.error ? `error=${delivery.error}` : null,
  ]
    .filter(Boolean)
    .join("  ");

function secretBlock(result: { endpoint: EndpointView; secret: string | null }, show: boolean | undefined): string {
  if (result.secret === null) return "";
  const label = result.endpoint.authMode === "bearer" ? "Bearer token" : "Signing secret";
  if (!show) return `\n${label} issued (ends …${result.endpoint.secretHint}) but not shown. Rotate with --show-secret, or rotate in the Webhooks panel, to see a secret.`;
  return `\n${label} (shown once): ${result.secret}`;
}

function redactSecret<T extends { secret: string | null }>(result: T, show: boolean | undefined): T {
  return show ? result : { ...result, secret: null };
}

export function registerCli(bb: BbPluginApi, service: Service, urlOf: (endpoint: EndpointView) => string) {
  bb.cli.register(
    defineCli({
      name: "webhooks",
      summary: "Manage inbound webhook endpoints",
      description:
        "Each endpoint authenticates a request (Standard Webhooks signature, Slack request signature, or bearer token), checks its JSON against declared fields, drops duplicates, and runs one fixed action: send to a thread, spawn a thread, or run an Automations automation (saved prompt only; no payload).",
      commands: {
        list: cliCommand({
          summary: "List endpoints",
          options: { ...json },
          run({ options }) {
            const overview = service.overview();
            const human = overview.endpoints.length === 0 ? "No endpoints. Create one with `bb webhooks create --config-stdin`." : overview.endpoints.map(endpointLine).join("\n");
            return ok(overview, human, options.json);
          },
        }),
        show: cliCommand({
          summary: "Show one endpoint, its URL, and recent deliveries",
          positionals: endpointArg,
          options: { limit: { type: "integer", min: 1, max: 200, default: 10, description: "Deliveries to show (1-200)" }, ...json },
          run({ positionals, options }) {
            return attempt(() => {
              const detail = service.get(positionals["endpoint-id"], options.limit);
              const endpoint = detail.endpoint;
              const human = [
                endpointLine(endpoint),
                `URL: ${urlOf(endpoint)}`,
                `Secret ends …${endpoint.secretHint} (set ${endpoint.secretUpdatedAt})`,
                `Fields: ${endpoint.fields.map((field) => `${field.name}=${field.path}:${field.type}${field.required ? "!" : ""}`).join(", ") || "none"}`,
                `Dedupe: ${endpoint.dedupe.source}${endpoint.dedupe.source === "field" ? ` (${endpoint.dedupe.field})` : ""}`,
                endpoint.rejectedSinceLoad ? `Rejected since load: ${endpoint.rejectedSinceLoad} (last: ${endpoint.lastRejectedReason})` : null,
                "",
                detail.deliveries.length ? detail.deliveries.map(deliveryLine).join("\n") : "No deliveries yet.",
              ]
                .filter((line) => line !== null)
                .join("\n");
              return ok({ ...detail, url: urlOf(endpoint) }, human, options.json);
            });
          },
        }),
        create: cliCommand({
          summary: "Create an endpoint from a JSON config",
          description:
            "See the webhooks skill for the config shape. Pass --secret-stdin to import an existing secret instead of generating one. A slack endpoint needs the Slack app's Signing Secret this way.",
          options: {
            config: { type: "string", required: true, stdin: true, description: "Endpoint config JSON", placeholder: "JSON" },
            secret: { type: "string", stdin: true, hidden: true, description: "Import this secret instead of generating one. Use --secret-stdin" },
            ...showSecret,
            ...json,
          },
          run({ options }) {
            return attempt(async () => {
              const result = await service.create({ config: parseJson(options.config, "config"), secret: options.secret });
              return ok(redactSecret({ ...result, url: urlOf(result.endpoint) }, options["show-secret"]), `Created ${endpointLine(result.endpoint)}\nURL: ${urlOf(result.endpoint)}${secretBlock(result, options["show-secret"])}`, options.json);
            });
          },
        }),
        update: cliCommand({
          summary: "Replace an endpoint's config",
          description: "The whole config is replaced. Changing authMode issues a new secret, or imports one with --secret-stdin. Changing to slack needs --secret-stdin.",
          positionals: endpointArg,
          options: {
            config: { type: "string", required: true, stdin: true, description: "Endpoint config JSON", placeholder: "JSON" },
            secret: { type: "string", stdin: true, hidden: true, description: "Import this secret when authMode changes. Use --secret-stdin" },
            ...showSecret,
            ...json,
          },
          run({ positionals, options }) {
            return attempt(async () => {
              const result = await service.update({ endpointId: positionals["endpoint-id"], config: parseJson(options.config, "config"), secret: options.secret });
              return ok(redactSecret(result, options["show-secret"]), `Updated ${endpointLine(result.endpoint)}${secretBlock(result, options["show-secret"])}`, options.json);
            });
          },
        }),
        enable: cliCommand({
          summary: "Enable an endpoint",
          positionals: endpointArg,
          options: { ...json },
          run({ positionals, options }) {
            return attempt(() => {
              const result = service.setEnabled(positionals["endpoint-id"], true);
              return ok(result, `Enabled ${endpointLine(result.endpoint)}`, options.json);
            });
          },
        }),
        disable: cliCommand({
          summary: "Disable an endpoint. Requests get 404 until it is enabled",
          positionals: endpointArg,
          options: { ...json },
          run({ positionals, options }) {
            return attempt(() => {
              const result = service.setEnabled(positionals["endpoint-id"], false);
              return ok(result, `Disabled ${endpointLine(result.endpoint)}`, options.json);
            });
          },
        }),
        delete: cliCommand({
          summary: "Delete an endpoint and its delivery history",
          positionals: endpointArg,
          options: { yes: { type: "boolean", description: "Confirm the delete" }, ...json },
          run({ positionals, options }) {
            return attempt(() => {
              if (!options.yes) throw new PluginCliError("Pass --yes to delete the endpoint and its delivery history.", { code: "confirmation_required" });
              const result = service.delete(positionals["endpoint-id"]);
              if (!result.deleted) throw new PluginCliError(`No endpoint ${positionals["endpoint-id"]}.`, { code: "not_found" });
              return ok(result, `Deleted ${positionals["endpoint-id"]}.`, options.json);
            });
          },
        }),
        "rotate-secret": cliCommand({
          summary: "Replace an endpoint's secret. The old one stops working at once",
          description: "A slack endpoint needs --secret-stdin with the Signing Secret you regenerated in Slack.",
          positionals: endpointArg,
          options: {
            secret: { type: "string", stdin: true, hidden: true, description: "Import this secret instead of generating one. Use --secret-stdin" },
            ...showSecret,
            ...json,
          },
          run({ positionals, options }) {
            return attempt(() => {
              const result = service.rotateSecret({ endpointId: positionals["endpoint-id"], secret: options.secret });
              const human = result.secret === null ? `Imported a new secret for ${result.endpoint.id} (ends …${result.endpoint.secretHint}).` : `Rotated ${result.endpoint.id}.${secretBlock(result, options["show-secret"])}`;
              return ok(redactSecret(result, options["show-secret"]), human, options.json);
            });
          },
        }),
        deliveries: cliCommand({
          summary: "List recent deliveries, newest first",
          positionals: endpointArg,
          options: { limit: { type: "integer", min: 1, max: 200, default: 20, description: "How many (1-200)" }, ...json },
          run({ positionals, options }) {
            return attempt(() => {
              const result = service.deliveries(positionals["endpoint-id"], options.limit);
              return ok(result, result.deliveries.length ? result.deliveries.map(deliveryLine).join("\n") : "No deliveries yet.", options.json);
            });
          },
        }),
        test: cliCommand({
          summary: "Sign a payload with the stored secret and post it to this server's route",
          description: "Standard-webhooks and slack endpoints only. Sends JSON. This runs the real action.",
          positionals: endpointArg,
          options: { payload: { type: "string", required: true, stdin: true, description: "JSON object to send", placeholder: "JSON" }, ...json },
          run({ positionals, options }) {
            return attempt(async () => {
              const result = await service.test({ endpointId: positionals["endpoint-id"], payload: parseJson(options.payload, "payload") });
              return ok(result, `HTTP ${result.status}\n${JSON.stringify(result.body, null, 2)}`, options.json);
            });
          },
        }),
      },
    }),
  );
}
