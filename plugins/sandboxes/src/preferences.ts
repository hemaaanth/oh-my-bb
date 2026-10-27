import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const sandboxIntegrationsSchema = z.object({
  projectEnvironments: z.boolean().default(false),
  catalog: z.boolean().default(false),
  agents: z.boolean().default(false),
  projects: z.boolean().default(false),
}).strict();
export type SandboxIntegration = keyof z.infer<typeof sandboxIntegrationsSchema>;
export const sandboxIntegrationPatchSchema = z.object({
  name: sandboxIntegrationsSchema.keyof(),
  enabled: z.boolean(),
}).strict();

export const integrationImportSchema = z.object({
  schemaVersion: z.literal(1),
  sourceGeneration: z.string().min(1).max(200),
  sourceSemanticDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  values: sandboxIntegrationsSchema,
}).strict();
const stateSchema = z.object({
  projectEnvironments: z.boolean().optional(),
  catalog: z.boolean().optional(),
  agents: z.boolean().optional(),
  projects: z.boolean().optional(),
  receipt: integrationImportSchema.extend({ completedAt: z.number() }).optional(),
}).strict();

/** Import preserves evidenced old call paths, not invented past consent. */
export function sandboxIntegrations(bb: BbPluginApi) {
  const key = "integrations:v1";
  const state = async () => stateSchema.parse(await bb.storage.kv.get(key) ?? {});
  const read = async () => {
    const { receipt: _, ...values } = await state();
    return sandboxIntegrationsSchema.parse(values);
  };
  let pending = Promise.resolve<unknown>(undefined);
  const mutate = <T>(action: () => Promise<T>): Promise<T> => {
    const result = pending.then(action);
    pending = result.catch(() => undefined);
    return result;
  };
  return {
    read,
    enabled: async (name: SandboxIntegration) => (await read())[name],
    update: (input: z.infer<typeof sandboxIntegrationPatchSchema>) => mutate(async () => {
      const value = sandboxIntegrationPatchSchema.parse(input);
      const next = { ...await state(), [value.name]: value.enabled };
      await bb.storage.kv.set(key, next);
      const { receipt: _, ...values } = next;
      return sandboxIntegrationsSchema.parse(values);
    }),
    import: (input: z.infer<typeof integrationImportSchema>) => mutate(async () => {
      const value = integrationImportSchema.parse(input);
      const previous = await state();
      if (previous.receipt) {
        const { completedAt: _, ...imported } = previous.receipt;
        if (JSON.stringify(imported) !== JSON.stringify(value)) throw new Error("Integration import generation/digest mismatch");
        return read();
      }
      await bb.storage.kv.set(key, { ...value.values, ...previous, receipt: { ...value, completedAt: Date.now() } });
      return read();
    }),
  };
}
