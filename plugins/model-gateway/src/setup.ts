// `bb gateway setup omp|fx|nanocodex|pi`. The
// CLI runs inside the BB server, so `setup omp|pi` edit the server machine's home.
import fs from "node:fs/promises";
import path from "node:path";

import {
  BEGIN, ompSnippet, upsertOmpProvider, sha256, validateSetupPath, type SetupFile,
} from "../scripts/apply-setup-files.mjs";
export { ompSnippet, upsertOmpProvider, applySetupFiles, checkSetupFiles } from "../scripts/apply-setup-files.mjs";
import { gatewayModels, type ModelMap } from "./chain.js";
import { gatewayModelDetails } from "./model-catalog.js";

export function gatewayBaseUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Expected an HTTP(S) server URL without credentials, query, or fragment.");
  return `${url.href.replace(/\/+$/u, "")}/api/v1/plugins/model-gateway/http/v1`;
}

/** Writes the block into `<home>/.omp/agent/models.yml`, backing up an existing file first. */
export async function writeOmpProvider(
  home: string,
  baseUrl: string,
  now: number,
): Promise<{ file: string; backup: string | null; changed: boolean }> {
  const file = path.join(home, ".omp", "agent", "models.yml");
  let text: string | null = null;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = upsertOmpProvider(text ?? "", baseUrl);
  if (next === text) return { file, backup: null, changed: false };
  let backup: string | null = null;
  if (text !== null) {
    backup = `${file}.bak-${now}`;
    await fs.copyFile(file, backup);
  } else {
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  await fs.writeFile(file, next);
  return { file, backup, changed: true };
}

export const FX_SETUP = `Optional integration: FX runs as a provider-acp custom agent (provider id
acp-fx), behind the standalone fx-acp package. Model Gateway does not install or
require FX or fx-acp. The adapter pins FX to its Codex subscription provider and
hides the Vercel AI Gateway and Grok providers.

1. Install the adapter:

   git clone --depth 1 https://github.com/hemaaanth/oh-my-bb.git
   npm pack --pack-destination . ./oh-my-bb/agents/fx-acp
   npm install --global ./fx-acp-0.1.0.tgz

2. In the customAgents setting of the ACP providers plugin, use this "fx" entry.
   customAgents is one JSON array: read it first, keep the other entries, and
   replace an old "fx" entry that runs "fx" "acp".

   { "id": "fx", "displayName": "FX", "command": "fx-acp" }

3. No FX login is needed for routed BB turns. The adapter uses FX's native
   host-managed auth mode and relays its loopback-only endpoint overrides to
   the gateway URLs. No OAuth file is copied or fabricated.

Without both contributed URLs, standalone FX keeps its existing login behavior.

The gateway sets FX_E2E_OPENAI_CODEX_RESPONSES_URL and FX_E2E_OPENAI_CODEX_MODELS_URL
for each acp-fx thread. Turn this off with bb gateway routing acp-fx --off.
`;

export const NANOCODEX_SETUP = `Optional integration: nanocodex runs as a provider-acp custom agent
(provider id acp-nanocodex) through the standalone nanocodex-acp package. Model
Gateway does not install or require nanocodex or nanocodex-acp.

1. Install the adapter:

   git clone --depth 1 --branch nanocodex-acp/v0.1.0 https://github.com/hemaaanth/oh-my-bb.git
   npm pack --pack-destination . ./oh-my-bb/agents/nanocodex-acp
   npm install --global ./nanocodex-acp-0.1.0.tgz
   nanocodex-acp --list-models

2. Append this entry to the customAgents setting of the ACP providers plugin.
   customAgents is one JSON array: read it first and keep the other entries.

{
  "id": "nanocodex",
  "displayName": "nanocodex",
  "command": "nanocodex-acp",
  "modelCli": {
    "listArgs": ["--list-models"],
    "selectFlag": "--model",
    "primaryModels": ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"]
  },
  "reasoningCli": {
    "flag": "--thinking",
    "supportedLevels": ["none", "low", "medium", "high", "xhigh", "max"],
    "defaultLevel": "medium"
  },
  "permissionCli": {
    "full": ["--permission-mode", "full"],
    "workspaceWrite": ["--permission-mode", "accept-edits"]
  }
}

The gateway sets NANOCODEX_API_BASE_URL and MODEL_GATEWAY_TOKEN for each
acp-nanocodex thread. gpt-6-* models run on the gateway's ChatGPT accounts.
kimi-k3, @cf/zai-org/glm-5.3 and mimo-v2.6-pro need an API-key upstream in the
acp-nanocodex chain, for example:

  printf '%s\n' "$KIMI_KEY" | bb gateway key add anthropic-compatible-key --label kimi --base-url <Kimi Anthropic base URL> --key-stdin
  bb gateway chain set acp-nanocodex chatgpt-oauth:* anthropic-compatible-key:kimi
`;

export const PRIME_SETUP = `Optional integration: install agents/prime-agent-acp from oh-my-bb on every host.
Prime Agent 0.10.0 must be on PATH. The gateway does not install either package.
Use this entry in provider-acp customAgents, keeping every other entry:

${JSON.stringify({
  id: "prime-agent", displayName: "Prime Agent", command: "prime-agent-acp",
  args: ["--mode", "acp"],
  modelCli: { listArgs: ["model-list"], selectFlag: "--model" },
}, null, 2)}

The adapter requires MODEL_GATEWAY_BASE_URL and MODEL_GATEWAY_TOKEN for inference.
It uses a private config and daemon socket for each launch. No local login fallback.
`;

const PI_MARKER = "// >>> model-gateway (managed by bb gateway setup pi)";

/**
 * A Pi extension that registers the `model-gateway` provider. Pi 0.87 ignores
 * base-URL env vars and does not expand env in a models.json `baseUrl`, so the
 * extension reads the per-thread env BB contributes. Without that env (outside
 * BB, or BB's model catalog) the models stay listed but cannot connect.
 */
export function piExtension(models: readonly string[]): string {
  return `${PI_MARKER}. Rerun that command to update; edits are overwritten.
// Routes Pi through the BB Model Gateway. BB sets MODEL_GATEWAY_BASE_URL and
// MODEL_GATEWAY_TOKEN for each Pi thread it routes.
const MODELS = ${JSON.stringify(models.map(gatewayModelDetails))};

export default function modelGateway(pi) {
  pi.registerProvider("model-gateway", {
    baseUrl: process.env.MODEL_GATEWAY_BASE_URL ?? "http://127.0.0.1:9/model-gateway-not-routed",
    apiKey: process.env.MODEL_GATEWAY_TOKEN ?? "model-gateway-not-routed",
    api: "openai-responses",
    models: MODELS.map(({ id, input, contextWindow, maxTokens }) => ({
      id,
      name: \`\${id} (Model Gateway)\`,
      reasoning: true,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    })),
  });
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.MODEL_GATEWAY_REQUIRED !== "1" && !process.env.BB_THREAD_ID && ctx.model?.provider !== "model-gateway") return;
    const selected = ctx.model;
    const models = ctx.modelRegistry?.getAll?.() ?? ctx.models?.list?.() ?? [];
    for (const provider of new Set(models.map((model) => model.provider))) {
      if (provider !== "model-gateway") pi.registerProvider(provider, { models: [] });
    }
    if (selected && selected.provider !== "model-gateway") {
      const id = MODELS.find((model) => model.id === selected.id || model.id === \`gw-\${selected.id}\`)?.id;
      const routed = id && (ctx.modelRegistry?.find("model-gateway", id) ?? ctx.models?.resolve(\`model-gateway/\${id}\`));
      if (!routed || !await pi.setModel(routed)) {
        ctx.shutdown();
        throw new Error("Select an available Model Gateway model before continuing.");
      }
    }
  });
}
`;
}

/**
 * Writes the extension into `<agentDir>/extensions/model-gateway.js`. The file is
 * wholly owned by the gateway; a file without the marker is never overwritten, and
 * a changed managed file is backed up first.
 */
export async function writePiExtension(
  agentDir: string,
  models: readonly string[],
  now: number,
): Promise<{ file: string; backup: string | null; changed: boolean }> {
  const file = path.join(agentDir, "extensions", "model-gateway.js");
  const next = piExtension(models);
  let text: string | null = null;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text === next) return { file, backup: null, changed: false };
  let backup: string | null = null;
  if (text !== null) {
    if (!text.startsWith(PI_MARKER))
      throw new Error(
        `${file} exists and is not managed by the gateway. Move it away, or copy the extension by hand from bb gateway setup pi --print.`,
      );
    backup = `${file}.bak-${now}`;
    await fs.copyFile(file, backup);
  } else {
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  await fs.writeFile(file, next);
  return { file, backup, changed: true };
}

/** One-time setup text per harness for the settings pane. The pane shows it; it never runs it. */
export function setupGuides(serverUrl: string): Record<
  "acp-omp" | "acp-fx" | "acp-nanocodex" | "acp-prime-agent" | "pi",
  string
> {
  return {
    "acp-omp": `Run once on each execution host:\n\n   bb gateway setup host\n\nOr add this under providers: in ~/.omp/agent/models.yml:\n\n${ompSnippet(gatewayBaseUrl(serverUrl))}\nOther hosts: bb gateway setup omp --print --server-url <that host's BB_SERVER_URL>.\n`,
    "acp-fx": FX_SETUP,
    "acp-nanocodex": NANOCODEX_SETUP,
    "acp-prime-agent": PRIME_SETUP,
    pi: "Run once on each execution host:\n\n   bb gateway setup host\n\nOther hosts and sandboxes: save the output of bb gateway setup pi --print as ~/.pi/agent/extensions/model-gateway.js. Run it again after the model map changes.\n",
  };
}

export function hostSetupFiles(
  input: { hostId: string; serverBaseUrl: string; piAgentDirs?: string[] },
  modelMap: ModelMap,
): { revision: string; files: SetupFile[] } {
  const content = ompSnippet(gatewayBaseUrl(input.serverBaseUrl), gatewayModels(modelMap).map((id) => ({ ...gatewayModelDetails(id), id: `gw-${id}` })));
  const files: SetupFile[] = [{
    path: ".omp/agent/models.yml", op: "managed-block", marker: BEGIN,
    content, sha256: sha256(content),
  }];
  for (const dir of new Set(input.piAgentDirs ?? [".pi/agent"])) {
    validateSetupPath(dir);
    const content = piExtension(gatewayModels(modelMap));
    files.push({
      path: `${dir}/extensions/model-gateway.js`, op: "managed-file",
      marker: PI_MARKER, content, sha256: sha256(content),
    });
  }
  const ompExtension = piExtension(gatewayModels(modelMap).map((id) => `gw-${id}`))
    .replace(/managed by bb gateway setup pi/gu, "managed by bb gateway setup host")
    .replace(/http:\/\/127\.0\.0\.1:9\/model-gateway-not-routed/gu, gatewayBaseUrl(input.serverBaseUrl));
  files.push({ path: ".omp/agent/extensions/model-gateway.js", op: "managed-file", marker: PI_MARKER.replace("setup pi", "setup host"), content: ompExtension, sha256: sha256(ompExtension) });
  files.push({ path: ".omp/agent/config.yml", op: "omp-settings", content: "{}", sha256: sha256("{}") });
  for (const dir of new Set(input.piAgentDirs ?? [".pi/agent"])) {
    const content = JSON.stringify({ defaultProvider: "model-gateway", defaultModel: "gpt-6.1-sol" });
    files.push({ path: `${dir}/settings.json`, op: "pi-settings", content, sha256: sha256(content) });
  }
  return { revision: sha256(JSON.stringify({ files: files.map(({ path, sha256 }) => [path, sha256]), modelMap })), files };
}
