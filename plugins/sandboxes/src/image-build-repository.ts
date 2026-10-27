import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const imageBuildRepositorySchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u, "Use a GitHub owner/repository, without a URL or credentials").refine(value => !value.endsWith(".git") && !value.endsWith("/.") && !value.endsWith("/.."), "Use a GitHub owner/repository");
export const imageBuildRepositoryImportSchema = z.object({
  schemaVersion: z.literal(1),
  sourceGeneration: z.string().min(1).max(200),
  sourceSemanticDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  repository: imageBuildRepositorySchema,
}).strict();
export type ImageBuildRepositoryImport = z.infer<typeof imageBuildRepositoryImportSchema>;
const stateSchema = z.object({
  explicit: imageBuildRepositorySchema.or(z.literal("")).optional(),
  receipt: imageBuildRepositoryImportSchema.extend({ completedAt: z.number() }).optional(),
}).strict();
export const imageBuildRepositoryViewSchema = z.object({
  repository: imageBuildRepositorySchema.nullable(),
  savedRepository: z.string().nullable(),
  source: z.enum(["environment", "preference", "import", "unconfigured"]),
  imported: z.boolean(),
});

export function resolveImageBuildRepository(input: { override?: string; explicit?: string; imported?: string }) {
  const override = input.override?.trim();
  const value = override || (input.explicit ?? input.imported);
  if (!value) throw new Error("No sandbox image builder configured. Set Sandboxes → Preferences → Image build repository or BB_SANDBOX_IMAGE_BUILD_REPO to a repository with sandbox-image.yml before upgrading images.");
  return imageBuildRepositorySchema.parse(value);
}

/** A single KV write commits the import and its receipt together. */
export function imageBuildRepositoryPreference(bb: BbPluginApi) {
  const key = "image-build-repository:v1";
  const read = async () => stateSchema.parse(await bb.storage.kv.get(key) ?? {});
  const resolve = async () => {
    const state = await read();
    return resolveImageBuildRepository({ override: process.env.BB_SANDBOX_IMAGE_BUILD_REPO, explicit: state.explicit, imported: state.receipt?.repository });
  };
  const view = async () => {
    const state = await read();
    const override = process.env.BB_SANDBOX_IMAGE_BUILD_REPO?.trim();
    const saved = state.explicit ?? state.receipt?.repository ?? null;
    return imageBuildRepositoryViewSchema.parse({
      repository: override ? imageBuildRepositorySchema.parse(override) : saved || null,
      savedRepository: saved,
      source: override ? "environment" : state.explicit !== undefined ? "preference" : state.receipt ? "import" : "unconfigured",
      imported: state.receipt !== undefined,
    });
  };
  // Serialize owner writes; concurrent import/save cannot erase a preference.
  let pending = Promise.resolve<unknown>(undefined);
  const write = <T>(action: () => Promise<T>): Promise<T> => {
    const result = pending.then(action);
    pending = result.catch(() => undefined);
    return result;
  };
  return {
    resolve, view,
    save: (repository: string) => write(async () => {
      const explicit = imageBuildRepositorySchema.or(z.literal("")).parse(repository.trim());
      await bb.storage.kv.set(key, { ...await read(), explicit });
      return view();
    }),
    import: (input: ImageBuildRepositoryImport) => write(async () => {
      const imported = imageBuildRepositoryImportSchema.parse(input);
      const state = await read();
      if (state.receipt) {
        const { completedAt: _, ...previous } = state.receipt;
        if (JSON.stringify(previous) !== JSON.stringify(imported)) throw new Error("Image build repository import generation/digest mismatch; existing receipt retained");
        return view();
      }
      await bb.storage.kv.set(key, { ...state, receipt: { ...imported, completedAt: Date.now() } });
      return view();
    }),
  };
}
