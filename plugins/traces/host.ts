import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { promptHostContract } from "./prompt-contract";
import { readPromptOnHost } from "./prompt-host";

// The same code runs on the enrolled host that executed the BB thread.
export default experimental_defineHostEntry({
  contract: promptHostContract,
  handlers: {
    promptRead: (input, context) => readPromptOnHost(input, context.signal),
  },
});
