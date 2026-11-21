import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { xUsageSnapshotSchema } from "./contracts.js";

const billingResponse = z.object({
  config: z.object({
    creditUsagePercent: z.number().min(0).max(100),
    currentPeriod: z.object({ end: z.string() }),
    prepaidBalance: z.object({ val: z.number() }).optional(),
  }),
  subscription_tier: z.string().trim().min(1).max(40),
});

const grokLogins = z.record(z.string(), z.object({ email: z.string().optional(), create_time: z.string().optional() }).passthrough());

/** The signed-in email from the Grok CLI login file. The newest login wins when there are several. */
export function grokEmailFromAuth(value: unknown): string | undefined {
  const parsed = grokLogins.safeParse(value);
  if (!parsed.success) return undefined;
  const email = Object.values(parsed.data)
    .filter((login) => login.email !== undefined && z.string().email().safeParse(login.email).success)
    .sort((left, right) => (right.create_time ?? "").localeCompare(left.create_time ?? ""))[0]?.email;
  return email;
}

async function readGrokEmail(): Promise<string | undefined> {
  const home = process.env.GROK_HOME ?? join(homedir(), ".grok");
  try { return grokEmailFromAuth(JSON.parse(await readFile(join(home, "auth.json"), "utf8"))); } catch { return undefined; }
}

export function parseXUsage(value: unknown, observedAt: number, email?: string) {
  const { config, subscription_tier: plan } = billingResponse.parse(value);
  const resetAt = Date.parse(config.currentPeriod.end);
  if (!Number.isFinite(resetAt)) throw new Error("Grok returned an invalid usage reset time.");
  return xUsageSnapshotSchema.parse({
    plan,
    weeklyUtilization: config.creditUsagePercent / 100,
    resetAt,
    observedAt,
    extraBalanceUsd: config.prepaidBalance?.val,
    source: "grok",
    ...(email === undefined ? {} : { email }),
  });
}

export async function readXUsage(signal?: AbortSignal) {
  const child = spawn("grok", ["agent", "stdio"], { stdio: ["pipe", "pipe", "ignore"], signal });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  let nextId = 0;
  let timer: NodeJS.Timeout | undefined;
  const send = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const closed = new Promise<never>((_, reject) => child.once("exit", (code) =>
    reject(new Error(`Grok usage reader exited before replying${code === null ? "" : ` (${code})`}.`))));
  lines.on("line", (line) => {
    let message: { id?: number; result?: unknown; error?: unknown };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) request.reject(message.error);
    else request.resolve(message.result);
  });
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Grok usage reader timed out.")), 12_000);
    });
    const request = async () => {
      const initialized = z.object({ _meta: z.object({ defaultAuthMethodId: z.string() }).passthrough() })
        .parse(await send("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "model-gateway", version: "1" },
        }));
      await send("authenticate", { methodId: initialized._meta.defaultAuthMethodId });
      const [billing, email] = await Promise.all([send("_x.ai/billing", {}), readGrokEmail()]);
      return parseXUsage(billing, Date.now(), email);
    };
    return await Promise.race([request(), timeout, closed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    lines.close();
    child.kill();
  }
}
