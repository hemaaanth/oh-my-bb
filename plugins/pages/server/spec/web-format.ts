// Adapted from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
export const plain = (html: unknown): string => typeof html === "string" ? html.replace(/<[^>]*>/g, " ").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name]!).replace(/\s+/g, " ").trim() : "";
export const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function https(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, "https://commons.wikimedia.org");
    for (const key of [...url.searchParams.keys()]) if (key.startsWith("utm_")) url.searchParams.delete(key);
    return url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}
