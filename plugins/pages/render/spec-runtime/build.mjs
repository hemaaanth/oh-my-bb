// Builds assets/spec.js: one minified IIFE with React, the spec component library, Highcharts, and the
// plugin's Tailwind CSS. Run after `bb plugin build`, which writes dist/app.css:  node render/spec-runtime/build.mjs
// The header records a hash of every source file in the bundle; a test fails when it no longer matches,
// so a page never draws an older component list than chat.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { specOptions, sourceHash } from "./options.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outfile = `${root}assets/spec.js`;
const result = await build({ ...specOptions(root, readFileSync(`${root}dist/app.css`, "utf8")), outfile, write: false, metafile: true });
const hash = sourceHash(root, result.metafile);
const code = `/*! Pages spec runtime ${hash}. React (c) Meta Platforms, Inc. (MIT). Highcharts (c) Highsoft AS, www.highcharts.com/license */\n${result.outputFiles[0].text}`;
writeFileSync(outfile, code);
const bytes = readFileSync(outfile);
console.log(`assets/spec.js ${(bytes.length / 1024).toFixed(1)} KiB, gzip ${(gzipSync(bytes, { level: 9 }).length / 1024).toFixed(1)} KiB`);
