import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import environment from "./environments/host.js";
import scripts from "./scripts-runtime/host.js";
export default experimental_defineHostEntry({
  contract: { ...environment.contract, ...scripts.contract },
  handlers: { ...environment.handlers, ...scripts.handlers },
});
