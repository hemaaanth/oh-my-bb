import { defineFunction, type EvaluationContext } from "@openuidev/lang-core";
import { z } from "zod";

interface MathDefinition {
  name: string;
  params: string[];
  description: string;
  run: (...args: number[]) => number | number[];
}
const definitions: MathDefinition[] = [
  { name: "Sin", params: ["x"], description: "Sine of x radians.", run: Math.sin },
  { name: "Cos", params: ["x"], description: "Cosine of x radians.", run: Math.cos },
  { name: "Tan", params: ["x"], description: "Tangent of x radians.", run: Math.tan },
  { name: "Asin", params: ["x"], description: "Inverse sine, in radians.", run: Math.asin },
  { name: "Acos", params: ["x"], description: "Inverse cosine, in radians.", run: Math.acos },
  { name: "Atan", params: ["x"], description: "Inverse tangent, in radians.", run: Math.atan },
  { name: "Atan2", params: ["y", "x"], description: "Angle of y/x, in radians, preserving its quadrant.", run: Math.atan2 },
  { name: "Sqrt", params: ["x"], description: "Square root of a nonnegative number.", run: Math.sqrt },
  { name: "Pow", params: ["base", "exponent"], description: "Base raised to exponent.", run: Math.pow },
  { name: "Exp", params: ["x"], description: "e raised to x.", run: Math.exp },
  { name: "Log", params: ["x"], description: "Natural logarithm of a positive number.", run: Math.log },
  { name: "Log10", params: ["x"], description: "Base-10 logarithm of a positive number.", run: Math.log10 },
  { name: "Clamp", params: ["value", "min", "max"], description: "Clamp a number to inclusive bounds.", run: (value, min, max) => Math.min(max, Math.max(min, value)) },
  { name: "Lerp", params: ["start", "end", "t"], description: "Linear interpolation; t=0 gives start and t=1 gives end.", run: (start, end, t) => start + (end - start) * t },
  { name: "Pi", params: [], description: "The circle constant pi.", run: () => Math.PI },
  { name: "Tau", params: [], description: "One full turn in radians, 2*pi.", run: () => 2 * Math.PI },
  { name: "Range", params: ["count"], description: "Integers 0 through count-1. Count must be an integer from 0 to 2000.", run: (count) => {
    if (!Number.isInteger(count) || count < 0 || count > 2000) throw new Error("Range count must be an integer from 0 to 2000.");
    return Array.from({ length: count }, (_, index) => index);
  } },
  { name: "Random", params: ["seed"], description: "A deterministic pseudorandom number from 0 to 1 for a numeric seed.", run: (seed) => {
    const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return value - Math.floor(value);
  } },
];

export const mathFunctions = definitions.map((definition) => defineFunction({
  name: definition.name,
  description: definition.description,
  params: z.object(Object.fromEntries(definition.params.map((name) => [name, z.number()]))),
  fn: (args: Record<string, number>) => {
    const value = definition.run(...definition.params.map((name) => args[name]));
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${definition.name} has no finite result for these inputs.`);
    return value;
  },
}));

/** The same functions for a Scene's quoted expression. OpenUI still owns parsing and evaluation. */
export const mathRuntimeFunctions: NonNullable<EvaluationContext["functions"]> = Object.fromEntries(mathFunctions.map((definition, index) => [definition.name, {
  params: { type: "object", properties: Object.fromEntries(definitions[index].params.map((name) => [name, { type: "number" }])) },
  fn: definition.fn,
}]));
