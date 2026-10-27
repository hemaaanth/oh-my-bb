import path from "node:path";

const assignmentPattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u;

function parseValue(raw: string, name: string): string {
  const value = raw.trim();
  if (!value) return "";
  const quote = value[0];
  if (quote !== "'" && quote !== '"') {
    const comment = value.search(/\s+#/u);
    return (comment < 0 ? value : value.slice(0, comment)).trimEnd();
  }

  const closing = value.lastIndexOf(quote);
  if (closing === 0 || !/^\s*(?:#.*)?$/u.test(value.slice(closing + 1))) {
    throw new Error(`The ${name} assignment is not a supported single-line dotenv value.`);
  }
  return value.slice(1, closing);
}

export function readDotenvValues(content: string, names: readonly string[]): Record<string, string> {
  const requested = new Set(names);
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const match = assignmentPattern.exec(line);
    if (!match || !requested.has(match[1])) continue;
    const name = match[1];
    if (Object.hasOwn(values, name)) throw new Error(`Credential handoff contains duplicate assignments for ${name}.`);
    values[name] = parseValue(match[2], name);
  }
  for (const name of names) {
    if (!Object.hasOwn(values, name) || !values[name]?.trim()) {
      throw new Error(`Credential handoff is missing ${name}.`);
    }
  }
  return values;
}

export function resolveHostPath(cwd: string, candidate: string): string {
  if (path.posix.isAbsolute(candidate)) return path.posix.normalize(candidate);
  if (path.win32.isAbsolute(candidate)) return path.win32.normalize(candidate);
  return path.posix.isAbsolute(cwd)
    ? path.posix.resolve(cwd, candidate)
    : path.win32.resolve(cwd, candidate);
}

export function credentialVariablePrefix(profileName: string): string {
  return profileName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
}
