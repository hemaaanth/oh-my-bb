// Owned by P3: phone calls (Twilio dial, SIP accept, sideband tool loop).
// The logic lives in ./telephony.ts. This file wires it to RPC and the CLI.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import { RECEIVE_FIELDS } from "../shared/contract.js";
import type { CliCommands, PhoneHandlers, ReceiveHandlers, ServerContext } from "./context.js";
import { appendTrace, openCalls } from "./ledger.js";
import { INCOMING_EVENT_TYPE, noteCaller, placeCall, receiveCall } from "./telephony.js";

const CLI_NOT_READY = "Phone calls are not set up. Missing:";

/**
 * Runs once at load, after registerCore. A phone call that was live when the
 * server stopped has lost its sideband for good, so its row is closed as unclean.
 */
export function registerPhone(ctx: ServerContext): void {
  for (const call of openCalls(ctx).filter((row) => row.channel === "phone")) {
    appendTrace(ctx, call.id, [{ kind: "call.stopped", at: Date.now(), payload: { unclean: true, reason: "connection lost" } }]);
    ctx.bb.log.warn("Dispatch closed a phone call row left open by a restart.");
  }
}

export function phoneRpcHandlers(ctx: ServerContext): PhoneHandlers {
  return { phoneDial: () => placeCall(ctx) };
}

/** The discoverable method the Webhooks plugin calls. */
export function receiveRpcHandlers(ctx: ServerContext): ReceiveHandlers {
  return {
    webhooks_receive: async (input, context) => {
      noteCaller(ctx, context.experimental_caller);
      const type = input.fields[RECEIVE_FIELDS.eventType];
      const sessionId = input.fields[RECEIVE_FIELDS.sessionId];
      // Other event types are not ours. A call event without a session id cannot be answered.
      if (type !== INCOMING_EVENT_TYPE || typeof sessionId !== "string" || sessionId.trim() === "") return { handled: false };
      const { accepted } = await receiveCall(ctx, sessionId.trim());
      return { handled: true, accepted };
    },
  };
}

/** `bb dispatch call`. */
export function phoneCommands(ctx: ServerContext): CliCommands {
  return {
    call: cliCommand({
      summary: "Call your phone and talk to the agent",
      async run() {
        const result = await placeCall(ctx);
        if (result.status === "placed") return { exitCode: 0, stdout: result.detail };
        if (result.status === "not-ready") {
          throw new PluginCliError(`${CLI_NOT_READY} ${result.missing.join(", ")}.`, { code: "not_ready" });
        }
        throw new PluginCliError(result.detail.split("\n")[0] || "The call failed.", { code: "failed" });
      },
    }),
  };
}
