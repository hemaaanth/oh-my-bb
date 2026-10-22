import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface HostCommandResult {
  exitCode: number;
  output: string;
}

/**
 * Run a command on a host and return its exit code together with its output.
 *
 * bb only serves terminal output while a session is running, so a terminal
 * started in `command` mode has already discarded its output by the time it
 * reports `exited`. Start a shell instead, fence the command with markers, and
 * drain the output while the session is still alive.
 */
export async function runHostCommand(
  bb: BbPluginApi,
  args: {
    hostId: string;
    cwd: string | null;
    command: string;
    title: string;
    timeoutMs?: number;
  },
): Promise<HostCommandResult> {
  const terminal = await bb.sdk.terminals.create({
    cols: 120,
    rows: 40,
    scope: { kind: "host_path", hostId: args.hostId, cwd: args.cwd },
    start: { mode: "shell" },
    title: args.title,
  });
  const deadline = Date.now() + (args.timeoutMs ?? 2 * 60_000);

  try {
    let current = terminal;
    while (current.status === "starting" && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      current = await bb.sdk.terminals.get({ terminalId: terminal.id });
    }
    if (current.status !== "running") {
      throw new Error(`${args.title} could not start a shell`);
    }

    const nonce = randomUUID().replaceAll("-", "");
    const startMarker = `__BB_SANDBOX_START_${nonce}__`;
    const doneMarker = `__BB_SANDBOX_DONE_${nonce}__`;
    const input = `printf '\n${startMarker}\n'; (\n${args.command}\n); __bb_sandbox_code=$?; printf '\n${doneMarker}%s\n' "$__bb_sandbox_code"\n`;
    await bb.sdk.terminals.input({
      terminalId: terminal.id,
      dataBase64: Buffer.from(input).toString("base64"),
    });

    let rawOutput = "";
    let nextSeq = 0;
    while (Date.now() < deadline) {
      const result = await bb.sdk.terminals.output({
        terminalId: terminal.id,
        sinceSeq: nextSeq,
        limitChunks: 100,
      });
      nextSeq = result.nextSeq;
      rawOutput += result.chunks
        .sort((left, right) => left.seq - right.seq)
        .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
        .join("");

      const done = rawOutput.match(new RegExp(`${doneMarker}(\\d+)`));
      if (done?.index !== undefined) {
        const start = rawOutput.lastIndexOf(startMarker, done.index);
        return {
          exitCode: Number(done[1]),
          output: rawOutput
            .slice(start + startMarker.length, done.index)
            .replace(/^\s+|\s+$/gu, ""),
        };
      }

      current = await bb.sdk.terminals.get({ terminalId: terminal.id });
      if (current.status === "exited") {
        throw new Error(`${args.title} exited before reporting its result`);
      }
      if (current.status === "disconnected") {
        throw new Error(`${args.title} disconnected from its host`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`${args.title} timed out`);
  } finally {
    await bb.sdk.terminals
      .close({ terminalId: terminal.id, mode: "force" })
      .catch(() => undefined);
  }
}
