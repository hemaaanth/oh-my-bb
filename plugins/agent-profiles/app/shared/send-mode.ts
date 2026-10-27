export const sendModes = ["auto", "steer", "followup", "fork"] as const;
export type SendMode = (typeof sendModes)[number];
export type DispatchAction = Exclude<SendMode, "auto">;

export const sendModeLabels: Record<SendMode, string> = {
  auto: "Auto",
  steer: "Steer",
  followup: "Follow-up",
  fork: "Fork",
};

export type ParsedSendMode = { text: string; mode: SendMode };
export const sendModeCommandPattern =
  /^\/(?:fork|steer|followup|follow-up|queue)(?=\s|$)/iu;

/** Commands are parsed once at the send boundary, never from quoted chat history. */
export function parseSendMode(
  text: string,
  mode: SendMode = "auto",
): ParsedSendMode {
  const match = /^\/(fork|steer|followup|follow-up|queue)(?=\s|$)\s*/iu.exec(
    text.trim(),
  );
  if (!match) return { text: text.trim(), mode };
  const command = match[1]!.toLowerCase();
  const action: DispatchAction =
    command === "fork" || command === "steer" ? command : "followup";
  if (mode !== "auto" && mode !== action)
    throw new Error(
      `The /${command} command conflicts with the selected ${sendModeLabels[mode]} mode.`,
    );
  return { text: text.trim().slice(match[0].length).trim(), mode: action };
}
