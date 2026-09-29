// `bb gateway setup omp|fx|nanocodex|pi`. The
// CLI runs inside the BB server, so `setup omp|pi` edit the server machine's home.
import fs from "node:fs/promises";
import path from "node:path";

const BEGIN = "# >>> model-gateway (managed by bb gateway setup omp)";
const END = "# <<< model-gateway";
const PROVIDERS = /^providers:[ \t]*(?:#.*)?$/mu;

export function gatewayBaseUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/u, "")}/api/v1/plugins/model-gateway/http/v1`;
}

function ompBlock(baseUrl: string, indent: string): string {
  return [
    BEGIN,
    `${indent}model-gateway:`,
    `${indent.repeat(2)}baseUrl: ${baseUrl}`,
    `${indent.repeat(2)}apiKey: MODEL_GATEWAY_TOKEN`,
    `${indent.repeat(2)}authHeader: true`,
    `${indent.repeat(2)}api: openai-responses`,
    `${indent.repeat(2)}discovery:`,
    `${indent.repeat(3)}type: openai-models-list`,
    END,
  ].join("\n");
}

export function ompSnippet(baseUrl: string): string {
  return `providers:\n${ompBlock(baseUrl, "  ")}\n`;
}

/**
 * Adds or replaces only the managed `model-gateway` provider block under the
 * top-level `providers:` key. Every other byte of the file stays as it was.
 */
export function upsertOmpProvider(text: string, baseUrl: string): string {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END, begin);
  if (begin >= 0 && end >= 0) {
    const indent = /\n([ \t]+)model-gateway:/u.exec(text.slice(begin))?.[1] ?? "  ";
    return (
      text.slice(0, begin) +
      ompBlock(baseUrl, indent) +
      text.slice(end + END.length)
    );
  }
  if (/^[ \t]+model-gateway:/mu.test(text))
    throw new Error(
      "models.yml already has an unmanaged model-gateway provider. Remove it, or edit it by hand with bb gateway setup omp --print.",
    );
  const providers = PROVIDERS.exec(text);
  if (providers === null) {
    if (/^providers:/mu.test(text))
      throw new Error(
        "models.yml writes providers: in a form this command cannot edit. Add the block by hand; see bb gateway setup omp --print.",
      );
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";
    return `${text}${separator}${ompSnippet(baseUrl)}`;
  }
  const after = providers.index + providers[0].length;
  // Match the indent of the first existing provider so siblings line up.
  const child = text
    .slice(after)
    .split("\n")
    .slice(1)
    .find((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  const indent = /^([ \t]+)/u.exec(child ?? "")?.[1] ?? "  ";
  return `${text.slice(0, after)}\n${ompBlock(baseUrl, indent)}${text.slice(after)}`;
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

   git clone --depth 1 --branch fx-acp/v0.1.0 https://github.com/hemaaanth/oh-my-bb.git
   npm pack --pack-destination . ./oh-my-bb/agents/fx-acp
   npm install --global ./fx-acp-0.1.0.tgz

2. In the customAgents setting of the ACP providers plugin, use this "fx" entry.
   customAgents is one JSON array: read it first, keep the other entries, and
   replace an old "fx" entry that runs "fx" "acp".

   { "id": "fx", "displayName": "FX", "command": "fx-acp" }

3. Sign FX in once on every host that runs FX threads, including each sandbox:

   fx login codex

   FX refuses its codex provider without that login. The gateway never forwards
   FX's own ChatGPT login: it serves FX from the gateway's ChatGPT accounts.

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
const MODELS = ${JSON.stringify(models)};

export default function modelGateway(pi) {
  pi.registerProvider("model-gateway", {
    baseUrl: process.env.MODEL_GATEWAY_BASE_URL ?? "http://127.0.0.1:9/model-gateway-not-routed",
    apiKey: process.env.MODEL_GATEWAY_TOKEN ?? "model-gateway-not-routed",
    api: "openai-responses",
    models: MODELS.map((id) => ({
      id,
      name: \`\${id} (Model Gateway)\`,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272000,
      maxTokens: 128000,
    })),
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
  "acp-omp" | "acp-fx" | "acp-nanocodex" | "pi",
  string
> {
  return {
    "acp-omp": `Run once on the BB server machine:\n\n   bb gateway setup omp\n\nOr add this under providers: in ~/.omp/agent/models.yml:\n\n${ompSnippet(gatewayBaseUrl(serverUrl))}\nOther hosts: bb gateway setup omp --print --server-url <that host's BB_SERVER_URL>.\n`,
    "acp-fx": FX_SETUP,
    "acp-nanocodex": NANOCODEX_SETUP,
    pi: "Run once on the BB server machine:\n\n   bb gateway setup pi\n\nOther hosts and sandboxes: save the output of bb gateway setup pi --print as ~/.pi/agent/extensions/model-gateway.js. Run it again after the model map changes.\n",
  };
}
