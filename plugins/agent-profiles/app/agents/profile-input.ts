import type { Profile, ProfileInput } from "../../server/contract";

// Kept apart from config-draft so the settings section can use it at startup
// without loading the draft validator.
export function profileInputFromProfile(profile: Profile): ProfileInput {
  return {
    id: profile.id,
    kind: profile.kind,
    name: profile.name,
    slug: profile.slug,
    description: profile.description,
    avatar: profile.avatar,
    modelMode: profile.modelMode,
    level: profile.level,
    providerId: profile.providerId,
    model: profile.model,
    reasoningLevel: profile.reasoningLevel,
    serviceTier: profile.serviceTier,
    runProjectId: profile.runProjectId,
    runHostId: profile.runHostId,
    runInCheckout: profile.runInCheckout,
    showInSidebar: profile.showInSidebar,
    permissionMode: profile.permissionMode,
    instructions: profile.instructions,
    skillIds: profile.skillIds,
    mcpServerIds: profile.mcpServerIds,
    isDefault: profile.isDefault,
  };
}
