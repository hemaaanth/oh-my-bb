import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { expect, it } from "vitest";
import entry from "./host";

it("reports a real loopback listener separately from a closed port", async () => {
  const server = createServer(socket => socket.destroy());
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  const { port } = server.address() as AddressInfo;
  const context = { signal: new AbortController().signal } as never;
  try {
    await expect(entry.handlers.probe_port({ port }, context)).resolves.toEqual({ state: "listening" });
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
  await expect(entry.handlers.probe_port({ port }, context)).resolves.toEqual({ state: "closed" });
});

it("honors cancellation before and during a port check", async () => {
  const controller = new AbortController();
  const pending = entry.handlers.probe_port({ port: 9 }, { signal: controller.signal } as never);
  controller.abort();
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(() => entry.handlers.probe_port({ port: 9 }, { signal: controller.signal } as never)).toThrow();
});
