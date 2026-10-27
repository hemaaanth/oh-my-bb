import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { materializeSkills } from "./materialize.js";
import type { ApprovedSkill } from "./store.js";

const skill: ApprovedSkill = {
  id: "skill_one",
  skillId: "source/one",
  sourceId: "source_one",
  sourceName: "Engineering",
  revision: "abc123",
  name: "One",
  description: "Test skill",
  relativePath: "skills/one",
  digest: "digest-one",
  enabled: true,
  files: [{ path: "SKILL.md", content: "---\nname: one\n---\n", contentEncoding: "utf8" }],
};

function api(files: object): BbPluginApi {
  return { sdk: { files } } as unknown as BbPluginApi;
}

describe("materializeSkills", () => {
  it("confines every mutation and creates the manifest with compare-and-swap", async () => {
    const mkdir = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const write = vi.fn(async () => ({ outcome: "written" as const, sha256: "next", sizeBytes: 1 }));
    const read = vi.fn(async () => { throw new Error("missing"); });

    await materializeSkills({
      bb: api({ mkdir, read, remove, write }),
      hostId: "host_one",
      roots: [
        { path: "/home/test/.bb/skills", rootPath: "/home/test/.bb" },
        { path: "/home/test/.agents/skills", rootPath: "/home/test" },
      ],
      manifestRoot: "/home/test/.bb",
      manifestPath: "/home/test/.bb/catalog/materializations/host_one.json",
      skills: [skill],
    });

    expect(mkdir.mock.calls.every(([call]) => typeof call.rootPath === "string")).toBe(true);
    expect(write.mock.calls.every(([call]) => typeof call.rootPath === "string")).toBe(true);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      path: "/home/test/.bb/catalog/materializations/host_one.json",
      rootPath: "/home/test/.bb",
      expectedSha256: null,
    }));
  });

  it("removes stale projections from a root that is retained only for cleanup", async () => {
    const stale = "/home/test/.bb/skills/catalog-engineering-one";
    const previous = JSON.stringify({ schemaVersion: 1, digest: "old", paths: [stale] });
    const remove = vi.fn(async () => undefined);
    const write = vi.fn(async () => ({ outcome: "written" as const, sha256: "next", sizeBytes: 1 }));

    const result = await materializeSkills({
      bb: api({
        mkdir: async () => undefined,
        read: async () => ({ content: previous, contentEncoding: "utf8", sha256: "old-sha" }),
        remove,
        write,
      }),
      hostId: "host_one",
      roots: [
        { path: "/home/test/.bb/skills", rootPath: "/home/test/.bb", publish: false },
        { path: "/home/test/.agents/skills", rootPath: "/home/test" },
      ],
      manifestRoot: "/home/test/.bb",
      manifestPath: "/home/test/.bb/catalog/materializations/host_one.json",
      skills: [skill],
    });

    expect(result.roots).toEqual(["/home/test/.agents/skills"]);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ path: stale, recursive: true }));
    expect(write).not.toHaveBeenCalledWith(expect.objectContaining({ path: `${stale}/SKILL.md` }));
  });

  it("rejects a stale manifest update after another materialization wins", async () => {
    const previous = JSON.stringify({ schemaVersion: 1, digest: "old", paths: [] });
    const current = JSON.stringify({ schemaVersion: 1, digest: "newer", paths: [] });
    const read = vi.fn()
      .mockResolvedValueOnce({ content: previous, contentEncoding: "utf8", sha256: "old-sha" })
      .mockResolvedValueOnce({ content: current, contentEncoding: "utf8", sha256: "new-sha" });
    const write = vi.fn(async (call: { path: string }) => call.path.endsWith(".json")
      ? { outcome: "conflict" as const, currentSha256: "new-sha" }
      : { outcome: "written" as const, sha256: "skill-sha", sizeBytes: 1 });

    await expect(materializeSkills({
      bb: api({
        mkdir: async () => undefined,
        read,
        remove: async () => undefined,
        write,
      }),
      hostId: "host_one",
      roots: [{ path: "/workspace/.bb/skills", rootPath: "/workspace" }],
      manifestRoot: "/workspace",
      manifestPath: "/workspace/.bb/skills/catalog-manifest.json",
      skills: [skill],
    })).rejects.toThrow("changed concurrently");

    expect(write).toHaveBeenCalledWith(expect.objectContaining({ expectedSha256: "old-sha" }));
  });

  it("creates each directory once no matter how many files land in it", async () => {
    const mkdir = vi.fn(async () => undefined);
    const write = vi.fn(async () => ({ outcome: "written" as const, sha256: "next", sizeBytes: 1 }));
    const read = vi.fn(async () => { throw new Error("missing"); });
    const many: ApprovedSkill = {
      ...skill,
      files: [
        { path: "SKILL.md", content: "---\nname: one\n---\n", contentEncoding: "utf8" },
        { path: "reference.md", content: "reference", contentEncoding: "utf8" },
        { path: "examples/one.md", content: "example", contentEncoding: "utf8" },
        { path: "examples/two.md", content: "example", contentEncoding: "utf8" },
      ],
    };

    await materializeSkills({
      bb: api({ mkdir, read, remove: async () => undefined, write }),
      hostId: "host_one",
      roots: [{ path: "/home/test/.bb/skills", rootPath: "/home/test/.bb" }],
      manifestRoot: "/home/test/.bb",
      manifestPath: "/home/test/.bb/catalog/materializations/host_one.json",
      skills: [many],
    });

    const paths = mkdir.mock.calls.map(([call]) => (call as { path: string }).path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("/home/test/.bb/skills/catalog-engineering-one/examples");
  });

  it("publishes a compact routing description while preserving the skill body", async () => {
    const write = vi.fn(async () => ({ outcome: "written" as const, sha256: "next", sizeBytes: 1 }));
    const longDescription = "Use this skill for a deliberately long routing description that explains the trigger clearly and then keeps listing details that belong in the full skill body rather than every provider prompt. It should be compact when projected.";
    const described: ApprovedSkill = {
      ...skill,
      description: longDescription,
      files: [{
        path: "SKILL.md",
        content: "---\nname: one\ndescription: |\n  Old multiline description.\nmetadata:\n  owner: test\n---\n\n# Full instructions\n",
        contentEncoding: "utf8",
      }],
    };

    await materializeSkills({
      bb: api({
        mkdir: async () => undefined,
        read: async () => { throw new Error("missing"); },
        remove: async () => undefined,
        write,
      }),
      hostId: "host_one",
      roots: [{ path: "/workspace/.agents/skills", rootPath: "/workspace" }],
      manifestRoot: "/workspace",
      manifestPath: "/workspace/.bb/skills/catalog-manifest.json",
      skills: [described],
    });

    const projected = write.mock.calls
      .map(([call]) => call as { path: string; content: string })
      .find((call) => call.path.endsWith("SKILL.md"))!;
    expect(projected.content).toContain("name: catalog-engineering-one");
    const renderedDescription = projected.content.match(/^description: (.+)$/mu)?.[1];
    expect(renderedDescription).toBeDefined();
    expect(JSON.parse(renderedDescription!).length).toBeLessThanOrEqual(160);
    expect(JSON.parse(renderedDescription!)).toMatch(/…$/u);
    expect(projected.content).not.toContain("Old multiline description");
    expect(projected.content).toContain("metadata:\n  owner: test");
    expect(projected.content).toContain("# Full instructions");
  });

  it("repeats a write the machine lost to a reconnect instead of failing the projection", async () => {
    let firstSkillWrite = true;
    const write = vi.fn(async (call: { path: string }) => {
      if (call.path.endsWith("SKILL.md") && firstSkillWrite) {
        firstSkillWrite = false;
        throw new Error("HTTP 502: Host is not connected");
      }
      return { outcome: "written" as const, sha256: "next", sizeBytes: 1 };
    });
    const read = vi.fn(async () => { throw new Error("missing"); });

    const result = await materializeSkills({
      bb: api({ mkdir: async () => undefined, read, remove: async () => undefined, write }),
      hostId: "host_one",
      roots: [{ path: "/home/test/.bb/skills", rootPath: "/home/test/.bb" }],
      manifestRoot: "/home/test/.bb",
      manifestPath: "/home/test/.bb/catalog/materializations/host_one.json",
      skills: [skill],
      hostRetry: { delayMs: 0 },
    });

    expect(result.ready).toBe(true);
    expect(write.mock.calls.filter(([call]) => call.path.endsWith("SKILL.md"))).toHaveLength(2);
  });

  it("gives up once the machine stays offline past the retry budget", async () => {
    const write = vi.fn(async () => { throw new Error("HTTP 502: Host is not connected"); });
    const read = vi.fn(async () => { throw new Error("missing"); });

    await expect(materializeSkills({
      bb: api({ mkdir: async () => undefined, read, remove: async () => undefined, write }),
      hostId: "host_one",
      roots: [{ path: "/home/test/.bb/skills", rootPath: "/home/test/.bb" }],
      manifestRoot: "/home/test/.bb",
      manifestPath: "/home/test/.bb/catalog/materializations/host_one.json",
      skills: [skill],
      hostRetry: { budgetMs: 0, delayMs: 0 },
    })).rejects.toThrow("Host is not connected");
  });
});
