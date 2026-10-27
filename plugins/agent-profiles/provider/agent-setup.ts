import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

/** Scripts stages a recipe in its short environment hook. Run it as accepted
 * turn work, outside RPC deadlines, before forwarding the saved model prompt. */
export async function runAgentSetup(env: Record<string, string> = {}, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Agent setup cancelled");
  if (env.AGENT_SETUP_ERROR) throw new Error(env.AGENT_SETUP_ERROR);
  const script = env.AGENT_SETUP_SCRIPT;
  if (!script) return;
  if (!isAbsolute(script)) throw new Error("Agent setup script must be absolute");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", [script], {
      env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch {}
      forceTimer ??= setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1_000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 600_000);
    signal?.addEventListener("abort", stop, { once: true });
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-8_000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(new Error("Agent setup cancelled"));
      else if (timedOut) reject(new Error("Agent setup timed out after ten minutes"));
      else if (code !== 0) reject(new Error(`Agent setup failed (${code}): ${errors}`));
      else resolve();
    });
  });
}
