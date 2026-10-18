// The esbuild options for assets/spec.js and the source hash in its header. build.mjs and the
// staleness test (spec-build.test.ts) share them, so both hash the same files.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Zod's error messages in other languages: the page never shows them, and they are a sixth of the bundle.
const noLocales = {
  name: "no-zod-locales",
  setup(build) {
    build.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/][^\\/]+\.js$/ }, ({ path }) =>
      /[\\/](en|index)\.js$/.test(path) ? undefined : { contents: "export default function locale() { return {}; }", loader: "js" });
  },
};

/** Build options; `root` is the plugin folder with a trailing slash, `appCss` the text of dist/app.css. */
export function specOptions(root, appCss) {
  return {
    absWorkingDir: root,
    entryPoints: [`${root}render/spec-runtime/main.tsx`],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome110", "firefox115", "safari16"],
    jsx: "automatic",
    minify: true,
    legalComments: "none",
    loader: { ".css": "text" },
    define: { __APP_CSS__: JSON.stringify(appCss), "process.env.NODE_ENV": '"production"' },
    plugins: [noLocales],
    logLevel: "warning",
  };
}

/**
 * A hash of the plugin's own files in the bundle (not node_modules). dist/app.css is left out: it is built from
 * the same files, and the tests run without a build.
 */
export function sourceHash(root, metafile) {
  const hash = createHash("sha256");
  for (const path of Object.keys(metafile.inputs).filter((path) => !path.includes("node_modules")).sort()) hash.update(path).update("\0").update(readFileSync(`${root}${path}`)).update("\0");
  return hash.digest("base64url").slice(0, 16);
}
