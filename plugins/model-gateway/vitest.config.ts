import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Node 26's built-in localStorage shadows jsdom's and is undefined without a file.
  test: { execArgv: ["--no-experimental-webstorage"] },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
