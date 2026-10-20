// Dispatch server entry. Owned by P0. It declares the setup settings, sets the
// needs-configuration banner, runs migrations, and hands one ServerContext to
// each package's register function. Packages add behavior in their own files.
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { CLI_COMMAND, DISPATCH_VERSION } from "../shared/constants.js";
import { coreCommands } from "./cli.js";
import type { ServerContext } from "./context.js";
import { MIGRATION_STATEMENTS } from "./migrations.js";
import { registerCore } from "./register-core.js";
import { phoneCommands, registerPhone } from "./register-phone.js";
import { registerRpc } from "./rpc.js";
import { SETUP_SETTINGS, isPresent, needsKeyMessage } from "./settings.js";

export { readContract, receiveContract, rpcContract } from "../shared/contract.js";
export type { ReadContract, ReceiveContract, RpcContract } from "../shared/contract.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETUP_SETTINGS);
  const values = await settings.get();

  // Phone fields never set the banner. Only a missing OpenAI key blocks a call.
  const needsConfiguration = !isPresent(values.openaiKey);
  if (needsConfiguration) bb.status.needsConfiguration(needsKeyMessage());

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATION_STATEMENTS]);

  const ctx: ServerContext = { bb, settings, db, needsConfiguration, version: DISPATCH_VERSION };

  // P1 runs first so readiness and the ledger exist before phone handlers use them.
  registerCore(ctx);
  registerPhone(ctx);
  registerRpc(ctx);

  bb.cli.register(
    defineCli({
      name: CLI_COMMAND,
      summary: "Talk to BB by voice, check setup, and read call usage",
      description:
        "Dispatch runs a voice agent in the app or over a phone call. These commands show live threads, stop or mute a call, place a phone call, and report usage.",
      commands: {
        ...coreCommands(ctx),
        ...phoneCommands(ctx),
      },
    }),
  );
}
