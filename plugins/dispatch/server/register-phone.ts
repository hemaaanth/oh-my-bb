// Owned by P3: phone calls (Twilio dial, SIP accept, sideband tool loop).
// P0 left placeholders only.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import type { CliCommands, PhoneHandlers, ReceiveHandlers, ServerContext } from "./context.js";
import { notImplemented } from "./context.js";

/** Runs once at load, after registerCore. */
export function registerPhone(_ctx: ServerContext): void {}

export function phoneRpcHandlers(_ctx: ServerContext): PhoneHandlers {
  return notImplemented(["phoneDial"]);
}

/** The discoverable method the Webhooks plugin calls. */
export function receiveRpcHandlers(_ctx: ServerContext): ReceiveHandlers {
  return {
    webhooks_receive: () => ({ handled: false }),
  };
}

/** `bb dispatch call`. */
export function phoneCommands(_ctx: ServerContext): CliCommands {
  return {
    call: cliCommand({
      summary: "Call your phone and talk to the agent",
      run() {
        throw new PluginCliError("Phone calls are not built yet.", { code: "not_implemented" });
      },
    }),
  };
}
