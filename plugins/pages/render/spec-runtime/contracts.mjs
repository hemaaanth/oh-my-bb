// Generate the author reference and the server's non-React schema from the same catalog.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "bb-pages-contracts-"));
process.env.DO_NOT_TRACK = "1";
try {
  const bundle = join(temp, "catalog.cjs");
  await build({
    absWorkingDir: root,
    stdin: { contents: 'export { specReference } from "./app/spec/reference.ts"; export { GROUPS, specLibrary } from "./app/spec/catalog.ts";', resolveDir: root },
    outfile: bundle, bundle: true, platform: "node", format: "cjs", target: "node22", jsx: "automatic",
    loader: { ".css": "text" }, logLevel: "warning",
  });
  const { specReference, specLibrary, GROUPS } = createRequire(import.meta.url)(bundle);
  const components = specLibrary.toSpec().components;
  const files = {
    ...Object.fromEntries(Object.entries(specReference()).map(([name, content]) => [`skills/pages/references/${name}`, content])),
    "server/spec/library.schema.json": `${JSON.stringify(specLibrary.toJSONSchema(), null, 1)}\n`,
    "server/spec/examples.json": `${JSON.stringify(GROUPS.flatMap((group) => group.entries.map((entry) => ({
      name: entry.component.name, group: group.id, description: entry.component.description,
      signature: components[entry.component.name].signature, examples: entry.examples.map(({ name, code }) => ({ name, code })),
    }))), null, 1)}\n`,
  };
  let changed = 0;
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    if (await readFile(path, "utf8").catch(() => null) === content) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    changed++;
  }
  console.log(`Pages contracts: ${Object.keys(files).length} files, ${changed} updated.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
