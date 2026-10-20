// What server/index.ts hands to every package, and the handler types each
// package fills in. Owned by P0.
import type { BbPluginApi, ExperimentalPluginRpcHandlersWithContext, PluginCliCommand } from "@get-bb/plugin-sdk";
import type { ReceiveContract, RpcContract, RpcMethod } from "../shared/contract.js";
import type { SetupSettingsHandle } from "./settings.js";

export type ServerContext = {
  bb: BbPluginApi;
  /** The only way to read setup values. Values never leave the server. */
  settings: SetupSettingsHandle;
  db: ReturnType<BbPluginApi["storage"]["database"]>;
  /** The needs-configuration banner was set at this load (no OpenAI key). */
  needsConfiguration: boolean;
  version: string;
};

type Handlers = ExperimentalPluginRpcHandlersWithContext<RpcContract>;

/** Methods P3 serves. P1 serves every other method. */
export type PhoneMethod = "phoneDial";
export type CoreMethod = Exclude<RpcMethod, PhoneMethod>;

export type CoreHandlers = Pick<Handlers, CoreMethod>;
export type PhoneHandlers = Pick<Handlers, PhoneMethod>;
export type ReceiveHandlers = ExperimentalPluginRpcHandlersWithContext<ReceiveContract>;

/** CLI subcommands keyed by invocation path. */
export type CliCommands = Record<string, PluginCliCommand>;

/** Placeholder handlers for methods a package has not built yet. */
export function notImplemented<M extends RpcMethod>(methods: readonly M[]): Pick<Handlers, M> {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      () => {
        throw new Error(`Dispatch cannot do ${method} yet.`);
      },
    ]),
  ) as unknown as Pick<Handlers, M>;
}
