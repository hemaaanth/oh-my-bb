import { spawn } from "node:child_process";

const MAX_OUTPUT_LENGTH = 32 * 1024;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export interface BuildAndPushSandboxImageInput {
  contextDir: string;
  dockerfilePath: string;
  reference: string;
  platform: string;
  bbAppVersion: string;
  registryUsername: string | null;
  registryToken: string | null;
  onLog?: (message: string) => void;
}

export interface PushedSandboxImage {
  reference: string;
  digest: string;
  pinnedReference: string;
}

interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runDocker(
  args: string[],
  options: { stdin?: string; onLog?: (message: string) => void } = {},
): Promise<DockerResult> {
  const child = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const pending = { stdout: "", stderr: "" };
  const emit = (channel: "stdout" | "stderr", chunk: string) => {
    if (options.onLog === undefined) return;
    const lines = `${pending[channel]}${chunk}`.split("\n");
    pending[channel] = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) options.onLog(line);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_LENGTH);
    emit("stdout", chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_LENGTH);
    emit("stderr", chunk);
  });
  // `docker version` and `imagetools inspect` never read stdin, so closing it
  // races their exit and can raise EPIPE. Only the login token needs delivery.
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.stdin ?? "");
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  for (const channel of ["stdout", "stderr"] as const) {
    if (pending[channel].trim().length > 0) options.onLog?.(pending[channel]);
  }
  return { stdout, stderr, exitCode };
}

/**
 * Docker Hub is the implicit registry for single-segment repositories, and
 * `docker login` wants no server argument for it.
 */
function registryServer(repository: string): string | null {
  const [candidate] = repository.split("/");
  if (candidate === undefined || repository.indexOf("/") < 0) return null;
  return candidate === "localhost" ||
    candidate.includes(".") ||
    candidate.includes(":")
    ? candidate
    : null;
}

function splitReference(reference: string): {
  repository: string;
  tag: string;
} {
  const separator = reference.lastIndexOf(":");
  const repository =
    separator > reference.lastIndexOf("/")
      ? reference.slice(0, separator)
      : reference;
  return {
    repository,
    tag: repository === reference ? "" : reference.slice(separator + 1),
  };
}

export async function buildAndPushSandboxImage(
  input: BuildAndPushSandboxImageInput,
): Promise<PushedSandboxImage> {
  const token = input.registryToken?.trim() ?? "";
  const redact = (text: string) =>
    token.length === 0 ? text : text.replaceAll(token, "[redacted]");
  const { repository } = splitReference(input.reference);
  let version: DockerResult;
  try {
    version = await runDocker(["version", "--format", "{{.Server.Version}}"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "The docker CLI is not installed on the bb server; install Docker to build the sandbox image",
      );
    }
    throw error;
  }
  if (version.exitCode !== 0) {
    throw new Error(
      `The Docker daemon is not reachable from the bb server: ${version.stderr.trim() || `docker version exited ${version.exitCode}`}`,
    );
  }
  input.onLog?.(`Docker daemon ${version.stdout.trim()}`);
  if (input.registryUsername !== null && token.length > 0) {
    const server = registryServer(repository);
    const login = await runDocker(
      [
        "login",
        ...(server === null ? [] : [server]),
        "--username",
        input.registryUsername,
        "--password-stdin",
      ],
      { stdin: token },
    );
    if (login.exitCode !== 0) {
      throw new Error(
        `Could not sign in to ${server ?? "Docker Hub"} as ${input.registryUsername}: ${redact(login.stderr.trim()) || `docker login exited ${login.exitCode}`}`,
      );
    }
    input.onLog?.(`Signed in to ${server ?? "Docker Hub"}`);
  }
  const build = await runDocker(
    [
      "buildx",
      "build",
      "--platform",
      input.platform,
      "--build-arg",
      `BB_APP_VERSION=${input.bbAppVersion}`,
      "--tag",
      input.reference,
      "--push",
      "--progress",
      "plain",
      "-f",
      input.dockerfilePath,
      input.contextDir,
    ],
    { onLog: input.onLog },
  );
  if (build.exitCode !== 0) {
    throw new Error(
      `docker buildx build exited ${build.exitCode}: ${redact(build.stderr.trim()).slice(-4_000) || "no output"}`,
    );
  }
  const inspect = await runDocker([
    "buildx",
    "imagetools",
    "inspect",
    input.reference,
    "--format",
    "{{json .Manifest.Digest}}",
  ]);
  let digest = "";
  if (inspect.exitCode === 0) {
    try {
      const parsed: unknown = JSON.parse(inspect.stdout.trim());
      if (typeof parsed === "string") digest = parsed.trim();
    } catch {
      digest = "";
    }
  }
  if (!digestPattern.test(digest)) {
    throw new Error(
      `Pushed ${input.reference} but could not resolve its digest, so providers cannot be pinned to it: ${redact(inspect.stderr.trim()) || "docker buildx imagetools inspect returned no digest"}`,
    );
  }
  const pinnedReference = `${repository}@${digest}`;
  input.onLog?.(`Pushed ${pinnedReference}`);
  return { reference: input.reference, digest, pinnedReference };
}
