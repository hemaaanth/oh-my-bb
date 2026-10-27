import * as z from "zod/mini";
import type { ProfileInput } from "../../server/contract";
import { modelLevels, modelModes } from "../../server/model-levels";
import {
  permissionModes,
  profileKinds,
  profileSlugPattern,
  reasoningLevels,
} from "../../server/profile-options";

export { profileInputFromProfile } from "./profile-input";

const trimmed = (min: number, max?: number) =>
  max === undefined
    ? z.string().check(z.trim(), z.minLength(min))
    : z.string().check(z.trim(), z.minLength(min), z.maxLength(max));

/**
 * Mirrors the server's profileInputSchema with zod/mini so restoring a saved
 * draft does not pull classic zod into the app bundle. config-draft.test.ts
 * keeps the two in step.
 */
export const draftProfileInputSchema = z.strictObject({
  id: z.optional(z.uuid()),
  name: trimmed(1, 80),
  slug: z.string().check(z.trim(), z.regex(profileSlugPattern), z.maxLength(60)),
  kind: z._default(z.enum(profileKinds), "full"),
  description: z.string().check(z.trim(), z.maxLength(240)),
  avatar: z._default(z.string().check(z.maxLength(16)), "🤖"),
  modelMode: z._default(z.enum(modelModes), "level"),
  level: z._default(z.enum(modelLevels), "medium"),
  providerId: trimmed(1),
  model: trimmed(1),
  reasoningLevel: z.enum(reasoningLevels),
  serviceTier: trimmed(1),
  permissionMode: z.enum(permissionModes),
  instructions: z.string().check(z.trim(), z.maxLength(32_000)),
  skillIds: z.array(trimmed(1, 200)).check(z.maxLength(100)),
  mcpServerIds: z.array(trimmed(1, 200)).check(z.maxLength(100)),
  runProjectId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  runHostId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  runInCheckout: z._default(z.boolean(), false),
  showInSidebar: z._default(z.boolean(), true),
  isDefault: z.boolean(),
});

export type ProfileDraft = {
  draft: ProfileInput;
  baseline: ProfileInput;
  skillIdsText: string;
  mcpServerIdsText: string;
  revision: number | null;
};

export type DocumentDraft = {
  text: string;
  doc: { text: string; version: string };
};

export function readConfigDraft<T>(key: string, validate: (value: unknown) => T): T | null {
  try {
    return validate(JSON.parse(localStorage.getItem(key) || "null"));
  } catch {
    return null;
  }
}

export function profileDraft(value: unknown): ProfileDraft {
  const draft = value as ProfileDraft;
  if (
    !draft ||
    typeof draft.skillIdsText !== "string" ||
    typeof draft.mcpServerIdsText !== "string" ||
    !(draft.revision === null || typeof draft.revision === "number")
  ) throw new Error("Invalid draft");
  return {
    ...draft,
    draft: parseProfileInput(draft.draft),
    baseline: parseProfileInput(draft.baseline),
  };
}

function parseProfileInput(value: unknown): ProfileInput {
  return draftProfileInputSchema.parse(value);
}

export function documentDraft(value: unknown): DocumentDraft {
  const draft = value as DocumentDraft;
  if (
    !draft ||
    typeof draft.text !== "string" ||
    typeof draft.doc?.text !== "string" ||
    typeof draft.doc?.version !== "string"
  ) throw new Error("Invalid draft");
  return draft;
}

export function writeConfigDraft(key: string, value: unknown | null) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}

export function parseIds(value: string) {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}
