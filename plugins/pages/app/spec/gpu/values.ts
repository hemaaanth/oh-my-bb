import type { Value } from "./types.js";
export type Props = Readonly<Record<string, Value>>;
export const ACCENT = "var(--bb-accent, var(--primary))";
export const finiteNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
export const text = (value: unknown): string => typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
export const list = (value: unknown): readonly Value[] => Array.isArray(value) ? value : [];
export const isObject = (value: unknown): value is Readonly<Record<string, Value>> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isBinding = (value: unknown): value is { kind: "binding"; value: Value } => isObject(value) && value.kind === "binding" && "value" in value;
