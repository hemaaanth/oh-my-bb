import { expect, it, vi } from "vitest";
import { createModalExecutor } from "../src/provider/backends/modal.js";

it("delivers nonempty stdin and closes its stream before waiting for command exit", async () => {
  let input = "";
  let finish!: () => void;
  const exited = new Promise<void>(resolve => { finish = resolve; });
  let output!: ReadableStreamDefaultController<string>;
  const process = {
    stdin: new WritableStream<string>({
      write(chunk) { input += chunk; },
      close() { output.enqueue(input); output.close(); finish(); },
    }),
    stdout: new ReadableStream<string>({ start(controller) { output = controller; } }),
    stderr: new ReadableStream<string>({ start(controller) { controller.close(); } }),
    closeStdin: vi.fn(() => { throw Error("Emergency EOF bypasses the input offset"); }),
    wait: async () => { await exited; return 0; },
  };
  const sandbox = { exec: vi.fn(async () => process) } as unknown as Parameters<typeof createModalExecutor>[0];
  const onOutput = vi.fn();
  expect(await createModalExecutor(sandbox).exec({ command: ["cat"], stdin: "enrollment-✓", timeoutMs: 1234, signal: new AbortController().signal, onOutput })).toEqual({ exitCode: 0 });
  expect(onOutput).toHaveBeenCalledWith("enrollment-✓");
  expect(sandbox.exec).toHaveBeenCalledWith(["cat"], expect.objectContaining({ timeoutMs: 2000 }));
  expect(process.closeStdin).not.toHaveBeenCalled();
});

it("forwards bootstrap progress while the command is still running", async () => {
  let finish!: () => void;
  const exited = new Promise<number>(resolve => { finish = () => resolve(0); });
  const stdout = new TransformStream<string, string>();
  const output = stdout.writable.getWriter();
  const sandbox = { exec: async () => ({
    stdin: new WritableStream<string>(), stdout: stdout.readable,
    stderr: new ReadableStream<string>({ start(controller) { controller.close(); } }),
    wait: () => exited,
  }) } as unknown as Parameters<typeof createModalExecutor>[0];
  const onOutput = vi.fn();
  const running = createModalExecutor(sandbox).exec({ command: ["bootstrap"], stdin: "", timeoutMs: 1000, signal: new AbortController().signal, onOutput });
  await output.write("Installing daemon\n");
  await vi.waitFor(() => expect(onOutput).toHaveBeenCalledWith("Installing daemon\n"));
  finish(); await output.close();
  expect(await running).toEqual({ exitCode: 0 });
});
