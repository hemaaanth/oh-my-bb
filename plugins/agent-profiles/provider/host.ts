import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { resolvePiNativeRoots } from "./native-roots.js";
import { memoryHostContract } from "./memory-contract.js";
import { AgentMemoryHost } from "./memory-host.js";

const memoryHosts = new Map<string, AgentMemoryHost>();
function memory(dataDir: string): AgentMemoryHost {
  let host = memoryHosts.get(dataDir);
  if (!host) { host = new AgentMemoryHost(dataDir); memoryHosts.set(dataDir, host); }
  return host;
}

export { experimental_providerBridge } from "./bridge/bridge.js";
export { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
export { resolvePiNativeRoots } from "./native-roots.js";

export default experimental_defineHostEntry({
  contract: { ...experimental_nativeRootsHostContract, ...memoryHostContract },
  handlers: {
    resolveNativeRoots: () =>
      resolvePiNativeRoots({ homeDir: homedir(), env: process.env }),
    memoryState: (input, context) => memory(context.experimental_paths.dataDir).state(input),
    memoryAcquire: (input, context) => memory(context.experimental_paths.dataDir).acquire(input, () => context.experimental_retainWorker(), context.signal),
    memoryPage: (input, context) => memory(context.experimental_paths.dataDir).page(input),
    memoryRead: (input, context) => memory(context.experimental_paths.dataDir).read(input),
    memoryRunning: (input, context) => memory(context.experimental_paths.dataDir).running(input),
    memoryReceive: (input, context) => memory(context.experimental_paths.dataDir).receive(input),
    memoryReceivePage: (input, context) => memory(context.experimental_paths.dataDir).receivePage(input),
    memoryWrite: (input, context) => memory(context.experimental_paths.dataDir).write(input),
    memoryCommit: (input, context) => memory(context.experimental_paths.dataDir).commit(input),
    memoryRelease: (input, context) => memory(context.experimental_paths.dataDir).release(input),
    memoryRemote: (input, context) => memory(context.experimental_paths.dataDir).remote(input),
    memoryRemotePage: (input, context) => memory(context.experimental_paths.dataDir).remotePage(input),
    memoryRemoteRead: (input, context) => memory(context.experimental_paths.dataDir).remoteRead(input),
    memoryRemoteDelete: (input, context) => memory(context.experimental_paths.dataDir).remoteDelete(input),
  },
  dispose: async () => { await Promise.all([...memoryHosts.values()].map((host) => host.dispose())); memoryHosts.clear(); },
});
