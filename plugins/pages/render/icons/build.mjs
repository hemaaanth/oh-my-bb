// Writes the MingCute icon files Pages ships. Run after changing GLYPHS or upgrading mingcute_icon:  node render/icons/build.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { json, spec, doc, counts } = generate(`${root}node_modules/mingcute_icon/svg`);
writeFileSync(`${root}assets/icons.json`, json);
writeFileSync(`${root}app/spec/icons.generated.tsx`, spec);
writeFileSync(`${root}skills/pages/references/icons.md`, doc);
console.log(`${counts.line} line and ${counts.fill} filled icons, assets/icons.json ${(json.length / 1024).toFixed(1)} KiB`);
