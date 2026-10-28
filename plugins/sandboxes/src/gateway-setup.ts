import { readFileSync } from "node:fs";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { runHostCommand } from "./host-command.js";

const setupSchema = z.object({
  revision: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    op: z.enum(["managed-block", "managed-file", "json-merge", "omp-settings", "pi-settings"]),
    marker: z.string().optional(), key: z.string().optional(), content: z.string(), sha256: z.string(),
  })).min(1),
});
export interface GatewaySetupResult {
  revision: string;
  current: boolean;
  files: Array<{ path: string; status: "current" | "missing" | "stale" }>;
}

// Host terminals receive the daemon's effective BB_SERVER_URL, including its
// machine-auth proxy. Bootstrap executor environments do not.
const runtimeSource = String.raw`
const os = require('node:os');
const path = require('node:path');
const serverBaseUrl = process.argv[1] || process.env.BB_SERVER_URL;
if (!serverBaseUrl) throw new Error('Sandbox runtime has no BB_SERVER_URL; refusing server-loopback fallback');
const runtime = { serverBaseUrl, home: os.homedir(), uid: process.getuid(), gid: process.getgid(), ...(process.env.PI_CODING_AGENT_DIR ? { piAgentDirs: [path.relative(os.homedir(), process.env.PI_CODING_AGENT_DIR)] } : {}) };
const url = new URL(runtime.serverBaseUrl);
if (url.username || url.password || url.search || url.hash) throw new Error('Expected a noncredential server base URL');
console.log('BB-GATEWAY-RUNTIME '+JSON.stringify(runtime));
`;
const runtimeSchema = z.object({ serverBaseUrl: z.url(), home: z.string().startsWith("/"), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), piAgentDirs: z.array(z.string()).optional() });

type Run = (command: string[], stdin?: string) => Promise<string>;

export async function reconcileGatewaySetup(bb: BbPluginApi, hostId: string, run: Run, check: boolean, bootstrap = false): Promise<GatewaySetupResult> {
  // During create/resume core has not activated the host yet. Managed harness
  // extensions use per-turn MODEL_GATEWAY_BASE_URL/TOKEN, never this fallback.
  // Port 9 fails closed for catalog/default configuration without those credentials.
  const raw = await run(["node", "-e", runtimeSource, ...(bootstrap ? ["http://127.0.0.1:9"] : [])]);
  const line = raw.split(/\r?\n/u).find(value => value.startsWith("BB-GATEWAY-RUNTIME "));
  if (!line) throw new Error("Sandbox did not report its server URL and user");
  const runtime = runtimeSchema.parse(JSON.parse(line.slice("BB-GATEWAY-RUNTIME ".length)));
  const setup = await bb.sdk.plugins.callRpc({
    pluginId: "model-gateway", method: "host.setupFiles",
    input: { hostId, serverBaseUrl: runtime.serverBaseUrl, ...(runtime.piAgentDirs ? { piAgentDirs: runtime.piAgentDirs } : {}) }, outputSchema: setupSchema,
  });
  const source = readFileSync(new URL("../docker/apply-setup-files.mjs", import.meta.url), "utf8");
  const runner = `import {checkSetupFiles,applySetupFiles} from ${JSON.stringify(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)};
let text='';for await (const chunk of process.stdin) text+=chunk;
const input=JSON.parse(text);
if(process.getuid()!==input.uid){if(process.getuid()!==0)throw new Error('Cannot apply as sandbox user');process.setgroups([]);process.setgid(input.gid);process.setuid(input.uid);}
const result=await (input.check?checkSetupFiles:applySetupFiles)(input.home,input.files);
const verified=await checkSetupFiles(input.home,input.files);
console.log('BB-GATEWAY-SETUP '+JSON.stringify({files:input.check?result.files:verified.files}));`;
  const output = await run(["node", "--input-type=module", "-e", runner], JSON.stringify({ ...runtime, files: setup.files, check }));
  const resultLine = output.split(/\r?\n/u).find(value => value.startsWith("BB-GATEWAY-SETUP "));
  if (!resultLine) throw new Error("Gateway setup did not report its file inventory");
  const result = z.object({ files: z.array(z.object({ path: z.string(), status: z.enum(["current", "missing", "stale"]) })).min(1) })
    .parse(JSON.parse(resultLine.slice("BB-GATEWAY-SETUP ".length)));
  const current = result.files.every(file => file.status === "current");
  if (!check && !current) throw new Error("Gateway setup files failed verification after apply");
  return { revision: setup.revision, current, files: result.files };
}

export function executorRunner(executor: MachineExecutor, signal: AbortSignal): Run {
  return async (command, stdin) => {
    let output = "";
    const result = await executor.exec({ command, stdin: stdin ?? "", signal,
      timeoutMs: 10 * 60_000, onOutput: chunk => { output += chunk; } });
    if (result.exitCode !== 0) throw new Error(`Sandbox preparation command failed (exit ${result.exitCode})${outputTail(output)}`);
    return output;
  };
}

/** The last lines of a command's output on a new line, so a failure names its cause. */
export function outputTail(output: string, lines = 15): string {
  const tail = output.split(/\r?\n/u).map(line => line.trimEnd()).filter(line => line && !line.startsWith("BB-UPGRADE-RESULT "))
    .slice(-lines).join("\n").slice(-2000);
  return tail ? `\n${tail}` : "";
}

export async function gatewaySetupOnHost(bb: BbPluginApi, hostId: string, check: boolean): Promise<GatewaySetupResult> {
  return reconcileGatewaySetup(bb, hostId, async (command, stdin) => {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const invocation = command.map(quote).join(" ");
    const result = await runHostCommand(bb, { hostId, cwd: null, title: "Sandbox gateway setup",
      command: stdin === undefined ? invocation : `printf '%s' ${quote(stdin)} | ${invocation}` });
    if (result.exitCode !== 0) throw new Error(`Gateway setup command failed (exit ${result.exitCode})`);
    return result.output;
  }, check);
}
