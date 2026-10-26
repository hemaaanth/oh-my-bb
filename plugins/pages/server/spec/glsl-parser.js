// Ported from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
// The parts of @shaderfrog/glsl-parser core/glsl-check.ts uses. The package's own
// declarations don't typecheck (they import an error.d.ts it doesn't ship)
// and this repo checks library types, so TypeScript reads the types from
// glsl-parser.d.ts beside this file and never loads the package's.
export { parse } from "@shaderfrog/glsl-parser";
export { preprocess } from "@shaderfrog/glsl-parser/preprocessor/index.js";
