import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const imageTools = [
  {
    "id": "omp",
    "label": "OMP",
    "category": "Agent CLIs",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "claude-code",
    "label": "Claude Code",
    "category": "Agent CLIs",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "codex",
    "label": "Codex",
    "category": "Agent CLIs",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "fx",
    "label": "FX",
    "category": "Agent CLIs",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "pi",
    "label": "Pi",
    "category": "Agent CLIs",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "prime-agent",
    "label": "Prime Agent",
    "category": "Agent CLIs",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "fx-acp",
    "label": "FX ACP",
    "category": "Agent CLIs",
    "defaultEnabled": true,
    "requires": [
      "fx"
    ]
  },
  {
    "id": "nanocodex-acp",
    "label": "nanocodex ACP",
    "category": "Agent CLIs",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "prime-agent-acp",
    "label": "Prime Agent ACP",
    "category": "Agent CLIs",
    "defaultEnabled": true,
    "requires": [
      "prime-agent"
    ]
  },
  {
    "id": "python",
    "label": "Python 3.13 + uv",
    "category": "Languages",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "go",
    "label": "Go",
    "category": "Languages",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "rust",
    "label": "Rust + nextest",
    "category": "Languages",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "java",
    "label": "Java 21",
    "category": "Languages",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "bun",
    "label": "Bun",
    "category": "Languages",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "deno",
    "label": "Deno",
    "category": "Languages",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "pnpm",
    "label": "pnpm",
    "category": "Languages",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "docker",
    "label": "Docker + Compose + Buildx",
    "category": "Environment and containers",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "mise",
    "label": "mise",
    "category": "Environment and containers",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "nix",
    "label": "Nix",
    "category": "Environment and containers",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "devbox",
    "label": "Devbox",
    "category": "Environment and containers",
    "defaultEnabled": true,
    "requires": [
      "nix"
    ]
  },
  {
    "id": "direnv",
    "label": "direnv",
    "category": "Environment and containers",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "process-compose",
    "label": "process-compose",
    "category": "Environment and containers",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "aws",
    "label": "AWS CLI",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "kubectl",
    "label": "kubectl",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "helm",
    "label": "Helm",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "doppler",
    "label": "Doppler",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "duckdb",
    "label": "DuckDB",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "op",
    "label": "1Password CLI",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": [
      "mise"
    ]
  },
  {
    "id": "clickhouse",
    "label": "ClickHouse",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": [
      "mise"
    ]
  },
  {
    "id": "postgresql",
    "label": "PostgreSQL client",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "redis",
    "label": "Redis tools",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "sqlite",
    "label": "SQLite",
    "category": "Cloud and data",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "freeze",
    "label": "Freeze",
    "category": "Capture",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "vhs",
    "label": "VHS + ttyd",
    "category": "Capture",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "cua",
    "label": "Computer use server",
    "category": "Capture",
    "defaultEnabled": true,
    "requires": [
      "python"
    ]
  },
  {
    "id": "build-tools",
    "label": "C/C++ build tools",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "clang",
    "label": "Clang",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "cmake",
    "label": "CMake",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "ninja",
    "label": "Ninja",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "gdb",
    "label": "GDB",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "protobuf",
    "label": "Protocol Buffers compiler",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "fzf",
    "label": "fzf",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "shellcheck",
    "label": "ShellCheck",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "strace",
    "label": "strace",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "tmux",
    "label": "tmux",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "vim",
    "label": "Vim",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "zsh",
    "label": "Zsh",
    "category": "Development utilities",
    "defaultEnabled": true,
    "requires": []
  },
  {
    "id": "goldsky",
    "label": "Goldsky",
    "category": "Project-specific CLIs",
    "defaultEnabled": false,
    "requires": []
  },
  {
    "id": "hubspot",
    "label": "HubSpot",
    "category": "Project-specific CLIs",
    "defaultEnabled": false,
    "requires": []
  }
] as const;
export const imageToolIds = ["omp", "claude-code", "codex", "fx", "pi", "prime-agent", "fx-acp", "nanocodex-acp", "prime-agent-acp", "python", "go", "rust", "java", "bun", "deno", "pnpm", "docker", "mise", "nix", "devbox", "direnv", "process-compose", "aws", "kubectl", "helm", "doppler", "duckdb", "op", "clickhouse", "postgresql", "redis", "sqlite", "freeze", "vhs", "cua", "build-tools", "clang", "cmake", "ninja", "gdb", "protobuf", "fzf", "shellcheck", "strace", "tmux", "vim", "zsh", "goldsky", "hubspot"] as const;
export const defaultImageTools: Array<(typeof imageToolIds)[number]> = imageTools.filter(tool => tool.defaultEnabled).map(tool => tool.id);
export const selectedImageToolsSchema = z.array(z.enum(imageToolIds)).max(imageToolIds.length).refine(ids => new Set(ids).size === ids.length, "Duplicate image tool");
export function normalizeImageTools(ids: readonly string[]): Array<(typeof imageToolIds)[number]> {
  const parsed = selectedImageToolsSchema.parse(ids);
  const selected = new Set<string>(parsed);
  for (const tool of imageTools) if (selected.has(tool.id)) {
    for (const dependency of tool.requires) if (!selected.has(dependency)) throw new Error(`${tool.label} requires ${dependency}`);
  }
  return imageToolIds.filter(id => selected.has(id));
}
export const imageDockerfileSchema = z.string().max(65_536).refine(value => {
  const lines = value.replace(/\\\r?\n/g, " ").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  return lines.every(line => /^(RUN|ENV|ARG|LABEL|WORKDIR|USER|SHELL)\s/i.test(line));
}, "Use RUN, ENV, ARG, LABEL, WORKDIR, USER or SHELL instructions to extend the BB image");
export const imageRecipeSchema = z.object({ revision: z.number().int().nonnegative(), tools: selectedImageToolsSchema, dockerfile: imageDockerfileSchema.optional() });
export type ImageRecipe = z.infer<typeof imageRecipeSchema>;
export function imageRecipePreference(bb: BbPluginApi) {
  const key = "image-recipe:v1";
  const read = async (): Promise<ImageRecipe> => {
    const stored = await bb.storage.kv.get(key);
    const recipe = stored === undefined ? { revision: 0, tools: defaultImageTools } : imageRecipeSchema.parse(stored);
    return { ...recipe, tools: normalizeImageTools(recipe.tools) };
  };
  let pending = Promise.resolve<unknown>(undefined);
  return { read, save: (input: ImageRecipe) => {
    const result = pending.then(async () => {
      const current = await read();
      if (input.revision !== current.revision) throw new Error("Image contents changed; reload before saving this draft");
      const tools = normalizeImageTools(input.tools);
      const dockerfile = imageDockerfileSchema.parse(input.dockerfile ?? current.dockerfile ?? "");
      if (JSON.stringify(tools) === JSON.stringify(current.tools) && dockerfile === (current.dockerfile ?? "")) return current;
      const next = { revision: current.revision + 1, tools, ...(dockerfile ? { dockerfile } : {}) };
      await bb.storage.kv.set(key, next);
      return next;
    });
    pending = result.catch(() => undefined);
    return result;
  } };
}
