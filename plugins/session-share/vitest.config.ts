import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname),
    },
  },
  test: {
    // The 0.4.84 SDK's bundled `@get-bb/plugin-sdk/host` entry ships an esbuild
    // `__require` shim (from cross-spawn) that throws "Dynamic require of
    // 'child_process' is not supported" when Vitest imports it as native ESM.
    // Inlining lets Vitest re-bundle the dependency with Node builtins provided.
    server: { deps: { inline: [/@get-bb\/plugin-sdk/] } },
  },
});
