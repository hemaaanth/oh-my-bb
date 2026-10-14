import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vendored registry components import through the `@/` alias, as in tsconfig.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
