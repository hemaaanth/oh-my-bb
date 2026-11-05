import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAndPushSandboxImage } from "../src/build-image.js";
import { writeBrowserArtifactFixture } from "./browser-artifact-fixture.js";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH ?? "";

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.BB_TEST_DOCKER_ARGV;
  delete process.env.BB_TEST_DOCKER_STDIN;
  delete process.env.BB_TEST_DOCKER_DIGEST;
  delete process.env.BB_TEST_DOCKER_NO_CACHE_EXPORT;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const digest = `sha256:${"b".repeat(64)}`;

async function fakeDocker(digestOutput: string): Promise<{
  argvLog: string;
  stdinLog: string;
  contextDir: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "bb-fake-docker-"));
  temporaryDirectories.push(directory);
  await writeBrowserArtifactFixture(directory);
  const argvLog = join(directory, "argv.log");
  const stdinLog = join(directory, "stdin.log");
  await writeFile(argvLog, "");
  await writeFile(stdinLog, "");
  const script = join(directory, "docker");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$BB_TEST_DOCKER_ARGV"',
      'if [ "$1" = "version" ]; then echo "28.1.2"; exit 0; fi',
      'if [ "$1" = "login" ]; then cat > "$BB_TEST_DOCKER_STDIN"; echo "Login Succeeded"; exit 0; fi',
      'if [ "$2" = "build" ] && [ -n "$BB_TEST_DOCKER_NO_CACHE_EXPORT" ] && printf "%s" "$*" | grep -q -- "--cache-to"; then echo "ERROR: Cache export is not supported for the docker driver." >&2; exit 1; fi',
      'if [ "$2" = "build" ]; then echo "#5 exporting layers" >&2; exit 0; fi',
      'if [ "$2" = "imagetools" ]; then printf "%s\\n" "$BB_TEST_DOCKER_DIGEST"; exit 0; fi',
      "exit 3",
      "",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  process.env.PATH = `${directory}:${originalPath}`;
  process.env.BB_TEST_DOCKER_ARGV = argvLog;
  process.env.BB_TEST_DOCKER_STDIN = stdinLog;
  process.env.BB_TEST_DOCKER_DIGEST = digestOutput;
  return { argvLog, stdinLog, contextDir: directory };
}

describe("buildAndPushSandboxImage", () => {
  it("signs in over stdin, pushes, and pins the pushed digest", async () => {
    const { argvLog, stdinLog, contextDir } = await fakeDocker(
      JSON.stringify(digest),
    );
    const logs: string[] = [];

    const pushed = await buildAndPushSandboxImage({
      contextDir,
      dockerfilePath: join(contextDir, "Dockerfile"),
      reference: "ghcr.io/acme/bb-sandbox:v1",
      platform: "linux/amd64",
      bbAppVersion: "0.38.0",
      registryUsername: "acme-bot",
      registryToken: "super-secret-token",
      onLog: (message) => logs.push(message),
    });

    expect(pushed).toEqual({
      reference: "ghcr.io/acme/bb-sandbox:v1",
      digest,
      pinnedReference: `ghcr.io/acme/bb-sandbox@${digest}`,
    });
    const argv = await readFile(argvLog, "utf8");
    expect(argv).toContain("login ghcr.io --username acme-bot --password-stdin");
    expect(await readFile(stdinLog, "utf8")).toBe("super-secret-token");
    expect(argv).not.toContain("super-secret-token");
    expect(logs.join("\n")).not.toContain("super-secret-token");
    expect(logs).toContain("#5 exporting layers");
    expect(argv).toContain(
      "--cache-from type=registry,ref=ghcr.io/acme/bb-sandbox:buildcache-linux-amd64",
    );
    expect(argv).toContain(
      "--cache-to type=registry,ref=ghcr.io/acme/bb-sandbox:buildcache-linux-amd64,mode=max",
    );
  });

  it("builds without saving layer cache when the builder cannot export it", async () => {
    const { argvLog, contextDir } = await fakeDocker(JSON.stringify(digest));
    process.env.BB_TEST_DOCKER_NO_CACHE_EXPORT = "1";
    const logs: string[] = [];

    await buildAndPushSandboxImage({
      contextDir,
      dockerfilePath: join(contextDir, "Dockerfile"),
      reference: "ghcr.io/acme/bb-sandbox:v1",
      platform: "linux/amd64",
      bbAppVersion: "0.38.0",
      registryUsername: null,
      registryToken: null,
      onLog: (message) => logs.push(message),
    });

    const builds = (await readFile(argvLog, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("buildx build"));
    expect(builds).toHaveLength(2);
    expect(builds[1]).toContain("--cache-from");
    expect(builds[1]).not.toContain("--cache-to");
    expect(logs.join("\n")).toContain("cannot export layer cache");
  });

  it("fails loudly when the pushed digest cannot be resolved", async () => {
    const { contextDir } = await fakeDocker("not-json");

    await expect(
      buildAndPushSandboxImage({
        contextDir,
        dockerfilePath: join(contextDir, "Dockerfile"),
        reference: "ghcr.io/acme/bb-sandbox:v1",
        platform: "linux/amd64",
        bbAppVersion: "0.38.0",
        registryUsername: null,
        registryToken: null,
      }),
    ).rejects.toThrow("could not resolve its digest");
  });

  it("keeps registry credentials out of failure messages", async () => {
    const { contextDir } = await fakeDocker(JSON.stringify("sha256:short"));

    await expect(
      buildAndPushSandboxImage({
        contextDir,
        dockerfilePath: join(contextDir, "Dockerfile"),
        reference: "ghcr.io/acme/bb-sandbox:v1",
        platform: "linux/amd64",
        bbAppVersion: "0.38.0",
        registryUsername: "acme-bot",
        registryToken: "super-secret-token",
      }),
    ).rejects.toThrow(/^(?!.*super-secret-token).*could not resolve/su);
  });

  it("names the missing prerequisite when docker is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-empty-path-"));
    temporaryDirectories.push(directory);
    await writeBrowserArtifactFixture(directory);
    await symlink("/usr/bin/tar", join(directory, "tar"));
    process.env.PATH = directory;

    await expect(
      buildAndPushSandboxImage({
        contextDir: directory,
        dockerfilePath: join(directory, "Dockerfile"),
        reference: "ghcr.io/acme/bb-sandbox:v1",
        platform: "linux/amd64",
        bbAppVersion: "0.38.0",
        registryUsername: null,
        registryToken: null,
      }),
    ).rejects.toThrow("docker CLI is not installed");
  });
});
