// Voice tool names in catalog order (CONTRACTS §2). Owned by P0.
// The prompt and the Tools settings list both use this order.

export const TOOL_NAMES = [
  "run_plugin_command",
  "get_context",
  "list_projects",
  "list_machines",
  "list_providers",
  "list_live_threads",
  "list_threads",
  "search_threads",
  "read_thread",
  "get_thread_error",
  "focus_thread",
  "focus_threads",
  "manage_views",
  "set_view_behavior",
  "set_pane",
  "send_to_thread",
  "set_thread_model",
  "start_thread",
  "stop_thread",
  "archive_thread",
  "rename_thread",
  "show_diff",
  "update_instructions",
  "recall_calls",
  "set_composer_text",
  "append_composer_text",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Only in the catalog for a mobile app realm. */
export const MOBILE_APP_TOOLS = ["focus_threads", "manage_views", "set_view_behavior"] as const satisfies readonly ToolName[];
/** Only in the catalog for the app channel, never on a phone call. */
export const APP_ONLY_TOOLS = ["set_pane", "set_composer_text", "append_composer_text"] as const satisfies readonly ToolName[];

/** Run in the app realm on the app channel. */
export const FRONTEND_TOOLS = [
  "get_context",
  "focus_thread",
  "focus_threads",
  "manage_views",
  "set_view_behavior",
  "set_pane",
  "set_composer_text",
  "append_composer_text",
] as const satisfies readonly ToolName[];
/** Run on the server, then the app brings the thread on screen. */
export const SERVER_THEN_FOCUS_TOOLS = ["send_to_thread", "start_thread", "show_diff"] as const satisfies readonly ToolName[];

/** Error results start with this. Every tool result is a string. */
export const TOOL_ERROR_PREFIX = "Error: ";
