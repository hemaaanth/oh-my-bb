import { rpcContract } from "./server.js";
export const scriptsRpcContract = Object.fromEntries(Object.entries(rpcContract).map(([name, method]) => [`scripts_${name}`, method])) as { [K in keyof typeof rpcContract as `scripts_${K & string}`]: (typeof rpcContract)[K] };
