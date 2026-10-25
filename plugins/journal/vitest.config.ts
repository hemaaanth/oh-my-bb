import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The app bundle's "@/..." imports (tsconfig paths) for jsdom slot tests.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    name: "bb-plugin-journal",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**"],
    // Calendar math is local-time math; pin a zone with a DST change.
    env: { TZ: "America/Toronto" },
  },
});
