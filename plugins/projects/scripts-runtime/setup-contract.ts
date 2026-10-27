import { createHash } from "node:crypto";
import { z } from "zod";

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).refine(name => !name.startsWith("AGENT_SETUP_") && !["BB_SETUP_DIR", "BB_WORKSPACE_DIR"].includes(name), "Reserved setup variable");
export const setupEnvironmentSchema = z.record(envName, z.string().max(4_096).refine(value => !value.includes("\0"), "Environment values cannot contain NUL"))
  .refine(value => Object.keys(value).length <= 50, "Too many setup variables");
export const agentSetupConfigSchema = z.object({
  script: z.string().trim().min(1).max(100),
  env: setupEnvironmentSchema.default({}),
}).strict();
export const setupRecipeSchema = z.object({
  name: z.string().min(1).max(100),
  script: z.string().min(1).max(100),
  command: z.string().trim().min(1).max(10_000),
  env: setupEnvironmentSchema,
  files: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u), z.string().max(50_000)).default({}),
}).strict().refine(value => Object.keys(value.files).length <= 8 && JSON.stringify(value).length <= 128_000, "Setup recipe is too large");
export type SetupRecipe = z.infer<typeof setupRecipeSchema>;
export function setupDigest(recipe: SetupRecipe) {
  return createHash("sha256").update(JSON.stringify({
    ...recipe,
    env: Object.fromEntries(Object.entries(recipe.env).sort(([a], [b]) => a.localeCompare(b))),
    files: Object.fromEntries(Object.entries(recipe.files).sort(([a], [b]) => a.localeCompare(b))),
  })).digest("hex");
}
export function setupApprovalDigest(hostId: string, workspacePath: string, recipe: SetupRecipe) {
  return createHash("sha256").update(hostId).update("\0").update(workspacePath).update("\0").update(setupDigest(recipe)).digest("hex");
}
export const setupPreviewSchema = z.object({
  environmentId: z.string().min(1), hostId: z.string().min(1), workspacePath: z.string().min(1),
  recipe: setupRecipeSchema, digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type SetupPreview = z.infer<typeof setupPreviewSchema>;
export const setupProfileSchema = z.object({ id: z.string().uuid(), slug: z.string(), name: z.string() });
