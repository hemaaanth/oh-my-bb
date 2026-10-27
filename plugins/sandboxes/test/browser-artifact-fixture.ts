import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const syntheticBrowserArtifact = {
  version: "0.3.0", sourceCommit: "a".repeat(40),
  inputsSha256: "b".repeat(64), archiveSha256: "c".repeat(64),
};
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function writeBrowserArtifactFixture(directory: string) {
  const source = join(directory, "artifact-source");
  await mkdir(source, { recursive: true });
  const bytes = JSON.stringify({ name: "bb-plugin-browser", version: "0.3.0" });
  await writeFile(join(source, "package.json"), bytes);
  await chmod(join(source, "package.json"), 0o644);
  const archive = execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", "-", "-C", source, "package.json"]);
  const inputs = { "package.json": { mode: 420, sha256: hash(bytes) } };
  const receipt = {
    schemaVersion: 1, packageName: "bb-plugin-browser", version: "0.3.0",
    sourceRepository: "https://github.com/hemaaanth/oh-my-bb",
    sourceCommit: syntheticBrowserArtifact.sourceCommit, sourcePackageTree: "d".repeat(40),
    buildRecipe: "gnu-tar-sort-name-mtime-0-owner-0-v1",
    inputsSha256: hash(`package.json\0${420}\0${hash(bytes)}\n`),
    archiveSha256: hash(archive), inputs,
  };
  await writeFile(join(directory, "browser-runtime.tar"), archive);
  await writeFile(join(directory, "browser-runtime.provenance.json"), JSON.stringify(receipt));
  return receipt;
}
