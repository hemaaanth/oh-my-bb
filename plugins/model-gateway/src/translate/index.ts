// Messages <-> Responses translation: Claude Code behind a Responses upstream (ChatGPT,
// Responses keys), and Responses clients behind an Anthropic-compatible key (P4).
// Pure functions, no BB imports; the hub calls these on a vendor mismatch.
export { messagesToResponses, TranslateError, type ResponsesRequest } from "./messages-to-responses.js";
export { responsesStreamToMessages, responsesJsonToMessages } from "./responses-to-messages.js";
export { estimateTokens } from "./token-estimate.js";
export {
  responsesToMessages,
  messagesStreamToResponses,
  messagesJsonToResponses,
  type ToolNames,
} from "./responses-to-anthropic.js";
export {
  ANTHROPIC_REPLAY,
  CHATGPT_REPLAY,
  fitReplay,
  wrapKeyOutput,
  wrapKeySse,
} from "./reasoning-envelope.js";
