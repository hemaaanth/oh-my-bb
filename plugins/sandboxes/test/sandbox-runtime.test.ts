import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { sandboxExecutor, sandboxName } from "../src/provider/runtime.js";

it("uses the daemon's real Node directory and preserves input, output and exit status", async () => {
  let output = "";
  const transport: MachineExecutor = { async exec(request) {
    const child = spawn(request.command[0]!, request.command.slice(1), { env: { ...process.env, PATH: `/vendor/bin:${process.env.PATH}` }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", chunk => request.onOutput(chunk.toString()));
    child.stderr.on("data", chunk => request.onOutput(chunk.toString()));
    child.stdin.end(request.stdin);
    return { exitCode: await new Promise<number>(resolve => child.on("close", code => resolve(code ?? 1))) };
  } };
  const result = await sandboxExecutor(transport).exec({
    command: [process.execPath, "-e", 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{console.log(process.env.PATH.split(":")[0]);console.log(s);process.exitCode=7;})'],
    stdin: "enrollment-✓", timeoutMs: 1000, signal: new AbortController().signal,
    onOutput: text => { output += text; },
  });
  expect(result.exitCode).toBe(7);
  expect(output).toBe(`${dirname(process.execPath)}\nenrollment-✓\n`);
});

it.each(["Daytona", "Modal", "E2B", "Boat", "Freestyle"])("names %s by project without relying on a hostname or thread event", async provider => {
  const bb = { sdk: { threads: { get: vi.fn(async () => ({ projectId: "proj-fixture", environmentId: null })) }, projects: { get: vi.fn(async () => ({ name: "slant" })) } } } as unknown as BbPluginApi;
  expect(await sandboxName(bb, provider, "thr_fixture")).toBe(`${provider} · slant`);
});
it("names personal workspaces and keeps an identifiable fallback when context is unavailable", async () => {
  const bb = { sdk: { threads: { get: vi.fn(async () => ({ projectId: null })) } } } as unknown as BbPluginApi;
  expect(await sandboxName(bb, "Boat", "thr_fixture")).toBe("Boat · Personal workspace");
  expect(await sandboxName({} as BbPluginApi, "Boat", "thr_fixture")).toBe("Boat · fixtur");
});
