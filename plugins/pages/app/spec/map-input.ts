import { readPlaces } from "./reports/map.js";
import type { Value } from "./reports/types.js";

export interface MapMarker {
  title: string;
  at: unknown;
  kind?: string;
  description?: string;
  image?: string;
  link?: string;
  day: string | null;
  wiki: string | null;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** Marker parts and trip records share one ordering and day-inheritance rule. */
export function mapMarkers(items: readonly unknown[]): MapMarker[] {
  const rows = items.map(item => typeof item === "string" ? { name: item } : record(record(item).props ?? item));
  const places = readPlaces(rows.map(row => ({ name: row.title ?? row.name, lat: Array.isArray(row.at) ? row.at[0] : row.lat, lng: Array.isArray(row.at) ? row.at[1] : row.lng, note: row.description ?? row.note, day: row.day, wiki: row.wiki })) as Value[]);
  return rows.map((row, index) => {
    const place = places[index];
    return {
      title: place?.name ?? "", at: Object.hasOwn(row, "at") ? row.at : place?.given ? [place.given.lat, place.given.lng] : place?.name ?? "",
      kind: text(row.kind), description: text(row.description) ?? place?.note ?? undefined, image: text(row.image), link: text(row.link), day: place?.day ?? null, wiki: place?.wiki ?? null,
    };
  });
}
