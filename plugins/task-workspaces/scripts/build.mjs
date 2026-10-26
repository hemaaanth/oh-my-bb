import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function publicSourcePath(source, packageRoot) {
  const scheme = source.match(/^([a-z][a-z0-9+.-]*:)(?=\/)/i)?.[1] ?? "";
  const value = source.slice(scheme.length);
  if (!isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) return source;
  const normalized = value.replaceAll("\\", "/");
  const root = packageRoot.replaceAll("\\", "/") + "/";
  const dependency = normalized.lastIndexOf("/node_modules/");
  const relative = dependency >= 0
    ? normalized.slice(dependency + 1)
    : normalized.startsWith(root)
      ? normalized.slice(root.length)
      : `external/${posix.basename(normalized)}`;
  return scheme ? scheme + relative : "../" + relative;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = spawnSync("bb", ["plugin", "build"], { cwd: packageRoot, stdio: "inherit" });
  if (built.error) throw built.error;
  if (built.status !== 0) process.exit(built.status ?? 1);
  const dist = join(packageRoot, "dist");
  for (const name of readdirSync(dist).filter((name) => name.endsWith(".map"))) {
    const path = join(dist, name);
    const map = JSON.parse(readFileSync(path, "utf8"));
    map.sources = map.sources.map((source) => publicSourcePath(source, packageRoot));
    writeFileSync(path, JSON.stringify(map) + "\n");
  }
}
