import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { experimental_killPortableProcess, experimental_spawnPortableProcess } from "@get-bb/plugin-sdk/provider-bridge";
import { HEMPI_COMMIT, HEMPI_FILES_GZIP_BASE64, HEMPI_SOURCE_SHA256 } from "../hempi-source.generated.js";
import { resolvePiLaunch } from "./rpc-child.js";

export function materializeHempi(dataDir: string): string {
  const parent = join(dataDir, "hempi");
  const cacheKey = `${HEMPI_COMMIT}-${HEMPI_SOURCE_SHA256.slice(0, 16)}`;
  const root = join(parent, cacheKey);
  const entry = join(root, "src/index.ts");
  const complete = join(root, ".complete");
  const ready = () => existsSync(entry) && existsSync(complete) && readFileSync(complete, "utf8") === HEMPI_SOURCE_SHA256;
  if (ready()) return entry;
  if (existsSync(root)) throw new Error(`Bundled Hempi cache is incomplete: ${root}`);
  const contents = gunzipSync(Buffer.from(HEMPI_FILES_GZIP_BASE64, "base64"));
  if (createHash("sha256").update(contents).digest("hex") !== HEMPI_SOURCE_SHA256) throw new Error("Bundled Hempi source checksum failed.");
  const files = JSON.parse(contents.toString("utf8")) as Record<string, string>;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(parent, `${cacheKey}.`));
  try {
    for (const [path, source] of Object.entries(files)) {
      if (!path || posix.isAbsolute(path) || path.includes("\\") || posix.normalize(path) !== path || path.startsWith("../")) throw new Error("Invalid bundled Hempi source path.");
      const file = join(stage, path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, source, { mode: 0o600 });
    }
    writeFileSync(join(stage, ".complete"), HEMPI_SOURCE_SHA256, { mode: 0o600 });
    try { renameSync(stage, root); }
    catch (error) { if (!ready()) throw error; }
    return entry;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function hempiExtensionArgs(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  args.signal?.throwIfAborted();
  const launch = resolvePiLaunch(process.env);
  const child = experimental_spawnPortableProcess({
    command: launch.command,
    args: [...launch.args, "--help"],
    cwd: args.cwd,
    env: { ...args.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  let failure: Error | undefined;
  const stop = (error: Error) => { failure ??= error; experimental_killPortableProcess(child, "SIGKILL"); };
  const abort = () => stop(args.signal?.reason instanceof Error ? args.signal.reason : new Error("Hempi discovery cancelled."));
  const timer = setTimeout(() => stop(new Error("Pi extension discovery timed out after 10 seconds.")), 10_000);
  timer.unref?.();
  args.signal?.addEventListener("abort", abort, { once: true });
  if (args.signal?.aborted) abort();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (output.length + chunk.length > 1024 * 1024) stop(new Error("Pi extension discovery exceeded 1 MiB."));
    else output += chunk;
  });
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Pi extension discovery failed (${code ?? signal}): ${stderr.trim()}`));
        else resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", abort);
  }
  const loaded = /^\s*--optchat-profile(?:\s|=|$)/m.test(output) && /^\s*--role(?:\s|=|$)/m.test(output);
  return loaded ? [] : ["--extension", materializeHempi(args.dataDir)];
}
