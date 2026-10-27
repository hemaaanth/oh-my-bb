import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [{
    name: "recipe-text",
    enforce: "pre",
    load(id) {
      if (id.endsWith(".py")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
    },
  }],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
