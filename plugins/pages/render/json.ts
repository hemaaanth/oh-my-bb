// Guards for reading untyped chart JSON (Highcharts options, Flint documents).

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value[key]` when value is a plain object, else undefined. */
export function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

/** value when it is an array, else []. */
export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** value when it is a non-empty string, else undefined. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** An axis option may be one object or an array; the first one counts. */
export function firstAxis(options: unknown, key: "xAxis" | "yAxis"): unknown {
  const axis = field(options, key);
  return Array.isArray(axis) ? axis[0] : axis;
}
