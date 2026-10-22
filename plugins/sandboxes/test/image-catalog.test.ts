import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeExtraPackages,
  prepareImageBuildContext,
  sandboxImageContextFiles,
} from "../src/image-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function sourceContext(dockerfile: string): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "bb-image-source-"));
  temporaryDirectories.push(source);
  for (const filename of sandboxImageContextFiles) {
    await writeFile(join(source, filename), filename);
  }
  await writeFile(join(source, "Dockerfile"), dockerfile);
  return source;
}

describe("sandbox image catalog", () => {
  it("stages the whole build context and replaces the package marker", async () => {
    const source = await sourceContext(
      "FROM node:22-bookworm-slim\nARG BB_APP_VERSION\n# bb:extra-packages\nCMD [\"bb-sandbox-entrypoint\"]\n",
    );

    const context = await prepareImageBuildContext({
      dockerfilePath: join(source, "Dockerfile"),
      extraPackages: ["protobuf-compiler", "imagemagick"],
    });
    const dockerfile = await readFile(context.dockerfilePath, "utf8");
    expect(await readdir(context.contextDir)).toEqual(
      [...sandboxImageContextFiles, "Dockerfile"].sort(),
    );
    expect(sandboxImageContextFiles).not.toContain("bb-app.tgz");
    expect(dockerfile).toContain(
      "apt-get install --yes --no-install-recommends imagemagick protobuf-compiler",
    );
    expect(dockerfile).not.toContain("# bb:extra-packages");
    expect(dockerfile.startsWith("FROM node:22-bookworm-slim\n")).toBe(true);
    expect(dockerfile.endsWith('CMD ["bb-sandbox-entrypoint"]\n')).toBe(true);
    await context.cleanup();
  });

  it("drops the marker line when no packages were requested", async () => {
    const source = await sourceContext(
      "FROM node:22-bookworm-slim\n# bb:extra-packages\nCMD [\"bb-sandbox-entrypoint\"]\n",
    );
    const context = await prepareImageBuildContext({
      dockerfilePath: join(source, "Dockerfile"),
      extraPackages: [],
    });
    expect(await readFile(context.dockerfilePath, "utf8")).toBe(
      "FROM node:22-bookworm-slim\nCMD [\"bb-sandbox-entrypoint\"]\n",
    );
    await context.cleanup();
  });

  it("refuses a Dockerfile without the extension point", async () => {
    const source = await sourceContext("FROM node:22-bookworm-slim\n");
    await expect(
      prepareImageBuildContext({
        dockerfilePath: join(source, "Dockerfile"),
        extraPackages: [],
      }),
    ).rejects.toThrow("# bb:extra-packages");
  });

  it("rejects package names that could smuggle shell syntax", () => {
    expect(() => normalizeExtraPackages(["curl;whoami"])).toThrow(
      "Invalid Debian package",
    );
  });
});
