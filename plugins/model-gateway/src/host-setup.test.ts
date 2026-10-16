import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { applySetupFiles, checkSetupFiles, hostSetupFiles } from "./setup.js";
import { sha256, type SetupFile } from "../scripts/apply-setup-files.mjs";

const homes: string[] = [];
const map = { "chatgpt-oauth": { "claude-opus-*": "gpt-6-sol" } };
const setup = (url = "https://sandbox.example", dirs?: string[]) => hostSetupFiles({ hostId: "host-sandbox", serverBaseUrl: url, piAgentDirs: dirs }, map);
async function home() { const dir = await fs.mkdtemp(path.join(tmpdir(), "mgw-setup-")); homes.push(dir); return dir; }
afterEach(async () => { await Promise.all(homes.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("host setup files", () => {
  it("uses the host URL, covers configured Pi dirs, and revises when URL or model map changes", () => {
    const generated = setup(undefined, [".pi/agent", ".profiles/sol"]);
    expect(generated.files.map((file) => file.path)).toEqual([".omp/agent/models.yml", ".pi/agent/extensions/model-gateway.js", ".profiles/sol/extensions/model-gateway.js"]);
    expect(generated.files[0]!.content).toContain("https://sandbox.example/api/v1/plugins/model-gateway/http/v1");
    expect(generated.files.every((file) => file.sha256 === sha256(file.content))).toBe(true);
    expect(setup().revision).not.toBe(setup("https://other.example").revision);
    expect(setup().revision).not.toBe(hostSetupFiles({ hostId: "h", serverBaseUrl: "https://sandbox.example" }, {}).revision);
  });

  it("checks a fresh HOME without writing, applies once, and is idempotent", async () => {
    const dir = await home(); const { files } = setup();
    expect((await checkSetupFiles(dir, files)).files.map((file) => file.status)).toEqual(["missing", "missing"]);
    expect(await fs.readdir(dir)).toEqual([]);
    expect((await applySetupFiles(dir, files)).files.every((file) => file.changed)).toBe(true);
    expect((await applySetupFiles(dir, files)).files.map((file) => [file.status, file.changed, file.backup])).toEqual([["current", false, null], ["current", false, null]]);
    expect(await fs.readFile(path.join(dir, files[1]!.path), "utf8")).toBe(files[1]!.content);
  });

  it("keeps unrelated OMP bytes and backs up changed managed files", async () => {
    const dir = await home(); const file = path.join(dir, ".omp/agent/models.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const original = "# user config\nproviders:\n    local:\n        apiKey: LOCAL_KEY\nmodelOverrides: {}\n";
    await fs.writeFile(file, original);
    const first = await applySetupFiles(dir, setup().files);
    expect(await fs.readFile(first.files[0]!.backup!, "utf8")).toBe(original);
    const before = await fs.readFile(file, "utf8");
    await applySetupFiles(dir, setup("https://changed.example").files);
    expect(await fs.readFile(file, "utf8")).toBe(before.replace("https://sandbox.example", "https://changed.example"));
  });

  it("refuses unmanaged conflicts before writing any file", async () => {
    const dir = await home(); const file = path.join(dir, ".pi/agent/extensions/model-gateway.js");
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "user code\n");
    await expect(applySetupFiles(dir, setup().files)).rejects.toThrow(/not managed/);
    await expect(fs.stat(path.join(dir, ".omp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(file, "utf8")).toBe("user code\n");
  });

  it("rejects traversal, credential URLs, tampered content, and symlinks", async () => {
    const dir = await home(); const files = setup().files;
    expect(() => setup(undefined, ["../outside"])).toThrow(/home-relative/);
    expect(() => setup("https://user:password@example.com")).toThrow(/credentials/);
    await expect(applySetupFiles(dir, [{ ...files[0]!, content: "changed" }])).rejects.toThrow(/digest/);
    await fs.symlink(await home(), path.join(dir, ".omp"));
    await expect(applySetupFiles(dir, files)).rejects.toThrow(/symlink/);
  });

  it("merges one JSON key, preserves others, and refuses a conflicting key", async () => {
    const dir = await home(); const content = '{"api":"openai-responses"}';
    const entry: SetupFile = { path: ".test/models.json", op: "json-merge", key: "model-gateway", content, sha256: sha256(content) };
    await fs.mkdir(path.join(dir, ".test")); await fs.writeFile(path.join(dir, entry.path), '{"other":{"x":1}}\n');
    await applySetupFiles(dir, [entry]);
    expect(JSON.parse(await fs.readFile(path.join(dir, entry.path), "utf8"))).toEqual({ other: { x: 1 }, "model-gateway": { api: "openai-responses" } });
    expect((await applySetupFiles(dir, [entry])).files[0]!.changed).toBe(false);
    const changed = '{"api":"different"}';
    await expect(applySetupFiles(dir, [{ ...entry, content: changed, sha256: sha256(changed) }])).rejects.toThrow(/conflict/);
  });
});
