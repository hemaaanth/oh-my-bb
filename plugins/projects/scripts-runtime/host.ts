import { createConnection, createServer, type AddressInfo } from "node:net";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract.js";
import { runSetup, stageSetup } from "./setup-host.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    stage_setup: ({ cwd, recipe }, context) => stageSetup(cwd, recipe, context.signal),
    run_setup: async ({ cwd, recipe }, context) => {
      const staged = await stageSetup(cwd, recipe, context.signal);
      return runSetup(staged.setupScript, context.signal);
    },
    probe_port: ({ port }, context) => {
      context.signal.throwIfAborted();
      const { promise, resolve, reject } = Promise.withResolvers<{ state: "listening" | "closed" | "unknown" }>();
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (state: "listening" | "closed" | "unknown") => {
        context.signal.removeEventListener("abort", abort);
        socket.destroy();
        resolve({ state });
      };
      const abort = () => {
        socket.destroy();
        context.signal.removeEventListener("abort", abort);
        reject(new Error("Port check cancelled"));
      };
      context.signal.addEventListener("abort", abort, { once: true });
      socket.setTimeout(350);
      socket.once("connect", () => finish("listening"));
      socket.once("error", error => finish((error as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "closed" : "unknown"));
      socket.once("timeout", () => finish("unknown"));
      return promise;
    },
    // Binds an ephemeral loopback port and releases it for the service to take.
    allocate_port: () => new Promise<{ port: number }>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve({ port }));
      });
    }),
  },
});
