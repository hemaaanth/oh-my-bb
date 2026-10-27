/**
 * Profile field options shared by the server contract and the app. Zod-free so
 * the app bundle can validate drafts without the full schema library.
 */
export const reasoningLevels = ["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"] as const;
export const permissionModes = ["auto", "accept-edits", "full"] as const;
export const profileKinds = ["full", "thin"] as const;
export const profileSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
