import { evaluate, parseExpression, tokenize, walkAST, type ASTNode } from "@openuidev/lang-core";
import { mathRuntimeFunctions } from "../math.js";
import type { FunctionValue, Value } from "./types.js";

/** Compile once using OpenUI. Only explicit data inputs and math functions are in scope. */
export function expressionFunction(source: string, params: readonly string[], inputs: Readonly<Record<string, unknown>> = {}): FunctionValue {
  let expression: ASTNode | undefined;
  let failure: string | null = null;
  let timeDependent = false;
  try {
    if (source.length > 64 * 1024) throw new Error("Scene expressions must be 64 KB or smaller.");
    expression = parseExpression(tokenize(source));
    walkAST(expression, (node) => { if (node.k === "StateRef" && node.n === "$t") timeDependent = true; });
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  return {
    kind: "function", params, timeDependent,
    call: (args) => {
      if (!expression) return { value: null, error: failure };
      try {
        const read = (name: string): unknown => {
          const plain = name.startsWith("$") ? name.slice(1) : name;
          const index = params.indexOf(plain);
          if (index >= 0) return args[index] ?? null;
          if (Object.hasOwn(inputs, plain)) return inputs[plain];
          throw new Error(`Unknown scene input $${plain}.`);
        };
        const value = evaluate(expression, {
          getState: read,
          resolveRef: (name) => { throw new Error(`Unknown scene reference ${name}. Use $t, $x, $z, or a named input.`); },
          functions: mathRuntimeFunctions,
          reportError: (message) => { throw new Error(message); },
        });
        return { value: value as Value, error: null };
      } catch (error) { return { value: null, error: error instanceof Error ? error.message : String(error) }; }
    },
  };
}

/** Quoted objects expressions use $t. Surface f expressions use $x, $z, and $t. */
export function prepareSceneObjects(objects: unknown, inputs: Readonly<Record<string, unknown>> = {}): Value {
  const dynamic = typeof objects === "string" ? expressionFunction(objects, ["t"], inputs) : null;
  const surfaces = new Map<string, FunctionValue>();
  let time: Value = 0;
  let moving = false;
  if (dynamic?.timeDependent) return animated(dynamic);
  const evaluated = dynamic?.call([0]) ?? { value: objects as Value, error: null };
  if (evaluated.error) return dynamic!;
  const prepared = adapt(evaluated.value);
  if (!moving) return prepared;
  return { kind: "function", params: ["t"], timeDependent: true, call: ([next]) => {
    time = next;
    return { value: prepared, error: null };
  } };

  function adapt(value: Value): Value {
    if (!Array.isArray(value)) return value;
    let converted: Value[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const object: Value = value[index];
      if (typeof object !== "object" || object === null || Array.isArray(object) || !("f" in object) || typeof object.f !== "string") continue;
      let f = surfaces.get(object.f);
      if (!f) {
        const sampled = expressionFunction(object.f, ["x", "z", "t"], inputs);
        moving ||= sampled.timeDependent === true;
        f = { kind: "function", params: ["x", "z"], call: ([x, z]) => sampled.call([x, z, time]) };
        surfaces.set(object.f, f);
      }
      converted ??= [...value];
      converted[index] = { ...object, f };
    }
    return converted ?? value;
  }

  function animated(fn: FunctionValue): FunctionValue {
    // Time-dependent objects are evaluated once per frame. Their static surface
    // expressions still share compiled functions rather than recompiling per point.
    return { kind: "function", params: ["t"], timeDependent: true, call: ([next]) => {
      time = next;
      const read = fn.call([next]);
      return read.error ? read : { value: adapt(read.value), error: null };
    } };
  }
}
