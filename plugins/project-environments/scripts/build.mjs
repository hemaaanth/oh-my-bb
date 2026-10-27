import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const built = spawnSync("bb", ["plugin", "build"], { cwd: packageRoot, stdio: "inherit" });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);

for (const name of readdirSync(join(packageRoot, "dist")).filter((name) => name.endsWith(".map"))) {
  const path = join(packageRoot, "dist", name);
  const map = JSON.parse(readFileSync(path, "utf8"));
  map.sources = map.sources.map((source) => {
    const scheme = source.match(/^([a-z][a-z0-9+.-]*:)(?=\/)/i)?.[1] ?? "";
    const value = source.slice(scheme.length);
    if (!isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) return source;
    const normalized = value.replaceAll("\\", "/");
    const dependency = normalized.lastIndexOf("/node_modules/");
    const relative = dependency >= 0 ? normalized.slice(dependency + 1)
      : normalized.startsWith(packageRoot + "/") ? normalized.slice(packageRoot.length + 1)
      : `external/${posix.basename(normalized)}`;
    return scheme ? scheme + relative : "../" + relative;
  });
  writeFileSync(path, JSON.stringify(map) + "\n");
}
