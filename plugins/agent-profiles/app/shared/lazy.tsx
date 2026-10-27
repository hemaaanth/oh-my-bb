import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

/**
 * Defer a component's module until it first renders.
 *
 * `bb plugin build` emits a single app.js (no code splitting), so each
 * import() is inlined, but esbuild wraps the imported module graph in lazy
 * initializers. Pages and the emoji picker therefore evaluate
 * when first shown instead of at every BB window's startup.
 */
export function deferred<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
  fallback: ReactNode = null,
): ComponentType<Props> {
  const Lazy = lazy(async () => ({ default: await load() }));
  function Deferred(props: Props) {
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return Deferred;
}
