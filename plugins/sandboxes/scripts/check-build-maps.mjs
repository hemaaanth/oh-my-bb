import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/", import.meta.url);
for (const name of await readdir(output)) {
  if (!name.endsWith(".map")) continue;
  const path = new URL(name, output);
  const map = JSON.parse(await readFile(path, "utf8"));
  const prefix = `bb-zod-locale-stub:${root}`;
  map.sources = map.sources.map(source => source.startsWith(prefix) ? `bb-zod-locale-stub:${source.slice(prefix.length)}` : source);
  if (JSON.stringify(map).includes(root) || map.sources.some(source => /^(?:\/home\/|\/Users\/|[A-Z]:[\\/])/u.test(source))) throw new Error(`Absolute build path in ${name}`);
  await writeFile(path, JSON.stringify(map) + "\n");
}
