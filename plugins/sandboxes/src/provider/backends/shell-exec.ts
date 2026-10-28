import { gzipSync } from "node:zlib";

/**
 * Shared helper for vendors whose command API takes a single shell string and
 * has no stdin channel. BB core's machine bootstrap runs argv with bootstrap
 * data on stdin; we render argv as a POSIX command and feed stdin over a base64
 * pipe (the sandbox image ships coreutils `base64`/`printf`). The decoded bytes
 * become the command's stdin.
 */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/gu, `'\\''`)}'`;
}

export function toShellCommand(
  argv: readonly string[],
  stdin: string,
): string {
  const quoted = argv.map(shQuote).join(" ");
  if (stdin.length === 0) return quoted;
  const bytes = Buffer.from(stdin, "utf8");
  // Large installers otherwise exceed vendor command limits after base64 expansion.
  const compressed = bytes.length > 8192;
  const b64 = (compressed ? gzipSync(bytes) : bytes).toString("base64");
  return `printf %s ${shQuote(b64)} | base64 -d${compressed ? " | gzip -dc" : ""} | ${quoted}`;
}
