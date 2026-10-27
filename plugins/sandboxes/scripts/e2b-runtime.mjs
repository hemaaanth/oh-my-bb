import { Sandbox, SandboxNotFoundError } from "e2b";

const action = process.argv[2];
if (!action) throw new Error("Missing E2B runtime action");
const apiKey = process.env.E2B_API_KEY?.trim();
if (!apiKey) throw new Error("E2B_API_KEY is not configured");

let body = "";
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);

if (action === "create") {
  const sandbox = await Sandbox.create(input.template, {
    apiKey,
    envs: input.env,
    metadata: input.metadata,
    timeoutMs: input.timeoutMs,
    lifecycle: input.lifecycle,
  });
  try {
    await sandbox.commands.run("bb-sandbox-entrypoint", {
      background: true,
      envs: input.env,
      user: "root",
    });
  } catch (error) {
    await Sandbox.kill(sandbox.sandboxId, { apiKey });
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({ action: "create", sandboxId: sandbox.sandboxId })}\n`,
  );
} else if (action === "destroy") {
  await Sandbox.kill(input.providerSandboxId, { apiKey });
  process.stdout.write(`${JSON.stringify({ action: "destroy" })}\n`);
} else if (action === "status") {
  let status;
  try {
    const info = await Sandbox.getInfo(input.providerSandboxId, { apiKey });
    status = info.state === "running" ? "running" : "stopped";
  } catch (error) {
    status = error instanceof SandboxNotFoundError ? "missing" : "unknown";
  }
  process.stdout.write(`${JSON.stringify({ action: "status", status })}\n`);
} else if (action === "sleep") {
  try {
    await Sandbox.pause(input.providerSandboxId, { apiKey, keepMemory: true });
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) throw error;
  }
  process.stdout.write(`${JSON.stringify({ action: "sleep" })}\n`);
} else if (action === "wake") {
  const sandbox = await Sandbox.connect(input.providerSandboxId, { apiKey });
  await sandbox.commands.run(
    "pgrep -f '[b]b-host-daemon' >/dev/null || setsid bb-sandbox-entrypoint >/tmp/bb-host-daemon.log 2>&1 </dev/null &",
    { user: "root" },
  );
  process.stdout.write(
    `${JSON.stringify({ action: "wake", sandboxId: sandbox.sandboxId })}\n`,
  );
} else if (action === "keepAlive") {
  await Sandbox.setTimeout(input.providerSandboxId, input.timeoutMs, {
    apiKey,
  });
  process.stdout.write(`${JSON.stringify({ action: "keepAlive" })}\n`);
} else if (action === "sample") {
  const sandbox = await Sandbox.connect(input.providerSandboxId, { apiKey });
  const result = await sandbox.commands.run(input.command, { user: "root" });
  if (result.exitCode !== 0) throw new Error(result.stderr || "E2B resource probe failed");
  const measured = JSON.parse(result.stdout);
  process.stdout.write(`${JSON.stringify({
    action: "sample",
    sample: { sampledAt: Date.now(), ...measured },
  })}\n`);
} else if (action === "create-native") {
  // Native BB 0.43 path: allocate WITHOUT enrollment env and WITHOUT launching
  // the daemon — BB core installs it over the exec action below.
  const sandbox = await Sandbox.create(input.template, {
    apiKey,
    metadata: input.metadata,
    timeoutMs: input.timeoutMs,
    lifecycle: input.lifecycle,
  });
  process.stdout.write(
    `${JSON.stringify({ action: "create-native", sandboxId: sandbox.sandboxId })}\n`,
  );
} else if (action === "exec") {
  const sandbox = await Sandbox.connect(input.providerSandboxId, { apiKey });
  const hasStdin = typeof input.stdin === "string" && input.stdin.length > 0;
  const options = {
    user: "root",
    background: true,
    stdin: hasStdin,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  };
  try {
    const command = await sandbox.commands.run(input.command, options);
    if (hasStdin) {
      await command.sendStdin(input.stdin);
      await command.closeStdin();
    }
    const result = await command.wait();
    process.stdout.write(
      `${JSON.stringify({ action: "exec", exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" })}\n`,
    );
  } catch (error) {
    // E2B throws CommandExitError on non-zero exit; recover the real code.
    const exitCode = typeof error?.exitCode === "number" ? error.exitCode : 1;
    process.stdout.write(
      `${JSON.stringify({ action: "exec", exitCode, stdout: error?.stdout ?? "", stderr: error?.stderr ?? String(error) })}\n`,
    );
  }
} else if (action === "resume-native") {
  // Connecting to a paused sandbox resumes it; do not relaunch the daemon —
  // BB core re-bootstraps over the executor.
  const sandbox = await Sandbox.connect(input.providerSandboxId, { apiKey });
  process.stdout.write(
    `${JSON.stringify({ action: "resume-native", sandboxId: sandbox.sandboxId })}\n`,
  );
} else {
  throw new Error(`Unsupported E2B runtime action: ${action}`);
}
