// Zod-free so the frontend can read the palette without bundling zod; the
// schema side lives in contract.ts.
export const projectGroupColors = ["amber", "blue", "violet", "green", "rose", "gray"] as const;
