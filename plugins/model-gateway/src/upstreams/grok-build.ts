import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

export const GROK_BUILD_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_BUILD_CREDENTIAL = "local:grok-build";
export const GROK_BUILD_LABEL = "grok-build-subscription";

const exec = promisify(execFile);
const credential = z.object({ key: z.string().min(1), expires_at: z.string() });
let renewal: Promise<void> | undefined;
let version: Promise<string> | undefined;

async function readCredential() {
  try {
    const directory = process.env.GROK_HOME || join(homedir(), ".grok");
    const data = JSON.parse(await readFile(join(directory, "auth.json"), "utf8")) as Record<string, unknown>;
    const matches = Object.values(data).map((value) => credential.safeParse(value))
      .flatMap((result) => result.success ? [result.data] : []);
    if (matches.length === 1) return matches[0]!;
  } catch { /* The CLI can rewrite credentials during renewal. */ }
  throw new Error("Grok Build needs one signed-in local account.");
}

export async function grokBuildHeaders() {
  let account = await readCredential();
  if (!(Date.parse(account.expires_at) > Date.now() + 60_000)) {
    renewal ??= exec("grok", ["models"], { timeout: 12_000, maxBuffer: 64_000 })
      .then(() => {}, () => { throw new Error("Grok Build could not renew its local sign-in."); })
      .finally(() => { renewal = undefined; });
    await renewal;
    account = await readCredential();
    if (!(Date.parse(account.expires_at) > Date.now())) throw new Error("Grok Build sign-in has expired.");
  }
  version ??= exec("grok", ["--version"], { timeout: 3_000, maxBuffer: 8_000 })
    .then(({ stdout }) => {
      const installed = /\bgrok\s+(\d+\.\d+\.\d+)\b/u.exec(stdout)?.[1];
      if (!installed) throw new Error("Could not read Grok Build version.");
      return installed;
    }).catch(() => {
      version = undefined;
      throw new Error("Could not read Grok Build version.");
    });
  return { authorization: `Bearer ${account.key}`, "x-grok-client-version": await version };
}
