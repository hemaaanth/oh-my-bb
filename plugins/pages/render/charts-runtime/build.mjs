// Builds assets/charts.js: one minified IIFE with Highcharts, its CSS, and the
// Pages chart theme. Run after changing anything in render/charts-runtime or
// render/chart-text.ts:  node render/charts-runtime/build.mjs
import { build } from "esbuild";
import { statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outfile = `${root}assets/charts.js`;
await build({
  entryPoints: [`${root}render/charts-runtime/main.ts`],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110", "firefox115", "safari16"],
  minify: true,
  legalComments: "none",
  loader: { ".css": "text" },
  // The bundle ships with pages; keep the Highcharts licence banner.
  banner: { js: "/*! Pages chart runtime. Highcharts (c) Highsoft AS, www.highcharts.com/license */" },
  logLevel: "warning",
});
const bytes = readFileSync(outfile);
console.log(`assets/charts.js ${(statSync(outfile).size / 1024).toFixed(1)} KiB, gzip ${(gzipSync(bytes, { level: 9 }).length / 1024).toFixed(1)} KiB`);
