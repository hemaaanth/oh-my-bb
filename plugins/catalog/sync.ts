import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, lstat, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { CatalogStore, DiscoveredSkill, Source, StoredFile } from "./store.js";

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_FILE_BYTES = 768 * 1024;
const MAX_SKILLS = 500;
const MAX_FILES_PER_SKILL = 200;

function normalizePath(value: string): string { return value.split(sep).join("/"); }

function frontmatterField(header: string, fieldName: string): string {
  const lines = header.split(/\r?\n/u);
  const index = lines.findIndex((line) => new RegExp(`^${fieldName}:`, "u").test(line));
  if (index < 0) return "";
  const raw = lines[index]!.slice(lines[index]!.indexOf(":") + 1).trim();
  if (/^[>|][+-]?$/u.test(raw)) {
    const values: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!/^\s+/u.test(line)) break;
      values.push(line.trim());
    }
    return raw.startsWith(">") ? values.join(" ").trim() : values.join("\n").trim();
  }
  return raw.replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2");
}

function parseFrontmatter(content: string, fallbackName: string): { name: string; description: string } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
  if (!match) throw new Error("SKILL.md needs YAML frontmatter");
  const header = match[1] ?? "";
  const name = frontmatterField(header, "name") || fallbackName;
  const description = frontmatterField(header, "description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) throw new Error(`Invalid skill name: ${name}`);
  if (!description) throw new Error(`${name} is missing a description`);
  return { name, description };
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile()) result.push(path);
    }
  }
  await visit(root);
  return result;
}

async function readStoredFile(path: string): Promise<Omit<StoredFile, "path">> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${basename(path)} exceeds ${MAX_FILE_BYTES} bytes`);
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), contentEncoding: "utf8" };
  } catch {
    return { content: bytes.toString("base64"), contentEncoding: "base64" };
  }
}

async function discoverSkills(root: string): Promise<DiscoveredSkill[]> {
  const allFiles = await walkFiles(root);
  const entrypoints = allFiles.filter((path) => basename(path) === "SKILL.md");
  if (entrypoints.length === 0) throw new Error("No SKILL.md files were found");
  if (entrypoints.length > MAX_SKILLS) throw new Error(`Source contains more than ${MAX_SKILLS} skills`);
  let totalBytes = 0;
  const names = new Set<string>();
  const skills: DiscoveredSkill[] = [];
  for (const entrypoint of entrypoints) {
    const skillRoot = resolve(entrypoint, "..");
    const skillFiles = allFiles.filter((path) => path === entrypoint || path.startsWith(`${skillRoot}${sep}`));
    if (skillFiles.length > MAX_FILES_PER_SKILL) throw new Error(`${normalizePath(relative(root, skillRoot))} contains too many files`);
    const files: StoredFile[] = [];
    for (const file of skillFiles.sort()) {
      const stored = await readStoredFile(file);
      totalBytes += stored.contentEncoding === "base64" ? Buffer.from(stored.content, "base64").byteLength : Buffer.byteLength(stored.content);
      if (totalBytes > MAX_SOURCE_BYTES) throw new Error(`Source exceeds ${MAX_SOURCE_BYTES} bytes of skill content`);
      files.push({ path: normalizePath(relative(skillRoot, file)), ...stored });
    }
    const skillEntrypoint = files.find((file) => file.path === "SKILL.md");
    if (skillEntrypoint?.contentEncoding !== "utf8") throw new Error("SKILL.md must be UTF-8 text");
    const skillContent = skillEntrypoint.content;
    const metadata = parseFrontmatter(skillContent, basename(skillRoot));
    if (names.has(metadata.name)) throw new Error(`Duplicate skill name: ${metadata.name}`);
    names.add(metadata.name);
    const relativePath = normalizePath(relative(root, skillRoot)) || ".";
    const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    skills.push({ skillId: relativePath, name: metadata.name, description: metadata.description, relativePath, digest, files });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function syncCatalogSource(store: CatalogStore, source: Source): Promise<{ source: Source; updated: boolean }> {
  const temporary = await mkdtemp(join(tmpdir(), "bb-catalog-sync-"));
  try {
    await execFileAsync("git", ["init", "--quiet", temporary], { timeout: 30_000 });
    await execFileAsync("git", ["-C", temporary, "remote", "add", "origin", source.repositoryUrl], { timeout: 30_000 });
    await execFileAsync("git", ["-C", temporary, "fetch", "--quiet", "--depth", "1", "origin", source.gitRef], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    await execFileAsync("git", ["-C", temporary, "checkout", "--quiet", "--detach", "FETCH_HEAD"], { timeout: 30_000 });
    const { stdout } = await execFileAsync("git", ["-C", temporary, "rev-parse", "HEAD"], { timeout: 30_000 });
    const revision = stdout.trim();
    const root = resolve(temporary, source.subdirectory || ".");
    if (root !== temporary && !root.startsWith(`${temporary}${sep}`)) throw new Error("Source subdirectory escapes the repository");
    const rootMetadata = await lstat(root).catch(() => null);
    if (!rootMetadata?.isDirectory()) throw new Error(`Source subdirectory does not exist: ${source.subdirectory}`);
    const skills = await discoverSkills(root);
    const saved = store.saveRelease(source.id, revision, skills, source.updatePolicy === "automatic");
    return { source: store.requireSource(source.id), updated: saved.changed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.markChecked(source.id, message.slice(0, 2_000));
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
