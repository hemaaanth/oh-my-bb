import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { toShellCommand } from "../src/provider/backends/shell-exec.js";

it.each(["input-✓", "# installer content\n".repeat(4000)])("delivers stdin intact while keeping large installer commands under 64 KiB", input => {
  const command = toShellCommand([process.execPath, "-e", 'process.stdin.pipe(process.stdout)'], input);
  expect(Buffer.byteLength(command)).toBeLessThan(64 * 1024);
  expect(execFileSync("sh", ["-c", command], { encoding: "utf8" })).toBe(input);
});
