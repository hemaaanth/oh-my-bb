import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const portableRoot = root.replaceAll("\\", "/");
for (const name of await readdir(dist)) {
  if (!name.endsWith(".map")) continue;
  const path = resolve(dist, name);
  const map = JSON.parse(await readFile(path, "utf8"));
  map.sources = map.sources.map((source) => source.replaceAll("\\", "/").replaceAll(`${portableRoot}/`, ""));
  if (map.sourceRoot?.replaceAll("\\", "/").includes(portableRoot)) delete map.sourceRoot;
  if (map.sources.some((source) => /(?:^|:)(?:\/|[A-Za-z]:[\\/])/.test(source))) {
    throw new Error(`Build source map contains an absolute machine path: ${name}`);
  }
  await writeFile(path, `${JSON.stringify(map)}\n`);
}
