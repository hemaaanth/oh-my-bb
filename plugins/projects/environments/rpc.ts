import { rpcContract } from "./contract.js";
export const environmentRpcContract = Object.fromEntries(
  Object.entries(rpcContract).map(([name, method]) => [`environment_${name}`, method]),
) as { [K in keyof typeof rpcContract as `environment_${K & string}`]: (typeof rpcContract)[K] };
