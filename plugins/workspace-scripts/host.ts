import { createServer, type AddressInfo } from "node:net";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
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
