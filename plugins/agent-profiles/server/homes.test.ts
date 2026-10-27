import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHomes } from "./homes";

const OLD_GUIDE = [
  "# Persistent agent workspace",
  "",
  "At the start of every turn, read MISSION.md and MEMORY.md in this directory.",
  "MISSION.md is the owner's standing direction. Do not change it unless the owner explicitly asks.",
  "Keep durable facts, decisions, and unfinished work in MEMORY.md. Update it before ending a turn.",
  "Owner rule: answer in French.",
  "",
].join("\n");

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function homeWith(files: Record<string, string>) {
  root = await mkdtemp(join(tmpdir(), "agent-homes-"));
  const homes = new AgentHomes({} as BbPluginApi, { name: join(root, "data.db") } as Database.Database);
  const home = homes.path("agent-1");
  await mkdir(home, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(home, name), text);
  return { homes, home };
}

describe("AgentHomes.retireMemory", () => {
  it("keeps MEMORY.md as MEMORY.legacy.md and swaps only the stock guide lines", async () => {
    const { homes, home } = await homeWith({ "AGENTS.md": OLD_GUIDE, "MEMORY.md": "Old fact.\n" });
    await homes.retireMemory("agent-1");
    expect((await readdir(home)).sort()).toEqual(["AGENTS.md", "MEMORY.legacy.md"]);
    expect(await readFile(join(home, "MEMORY.legacy.md"), "utf8")).toBe("Old fact.\n");
    const guide = await readFile(join(home, "AGENTS.md"), "utf8");
    expect(guide).not.toContain("MEMORY.md");
    expect(guide).toContain("Owner rule: answer in French.");
    expect(guide).toContain("agent_persona_update");
    expect(guide).toContain("MISSION.md is the owner's standing direction.");

    await homes.retireMemory("agent-1");
    expect(await readFile(join(home, "AGENTS.md"), "utf8")).toBe(guide);
  });

  it("deletes an untouched starter memory instead of keeping it", async () => {
    const { homes, home } = await homeWith({
      "MEMORY.md": "# Memory\n\nRecord durable facts, decisions, and unfinished work here.\n",
    });
    await homes.retireMemory("agent-1");
    expect(await readdir(home)).toEqual([]);
  });

  it("leaves a customized guide and a missing memory alone", async () => {
    const custom = "Read MEMORY.md for my own notes.\n";
    const { homes, home } = await homeWith({ "AGENTS.md": custom });
    await homes.retireMemory("agent-1");
    expect(await readdir(home)).toEqual(["AGENTS.md"]);
    expect(await readFile(join(home, "AGENTS.md"), "utf8")).toBe(custom);
  });
});
