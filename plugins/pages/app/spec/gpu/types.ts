/** Evaluated GPU values. Functions are backed by the OpenUI evaluator, never JavaScript source. */
export type Value = string | number | boolean | null | readonly Value[] | { readonly [key: string]: Value } | FunctionValue;
export interface FunctionValue {
  readonly kind: "function";
  readonly params: readonly string[];
  readonly timeDependent?: boolean;
  readonly call: (args: readonly Value[]) => { readonly value: Value; readonly error: string | null };
}
export function isFunctionValue(value: unknown): value is FunctionValue {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "function" && "call" in value && typeof value.call === "function";
}
