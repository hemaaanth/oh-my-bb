// The six declared setup settings (CONTRACTS §7). Owned by P0.
// All are secret, so no value reaches the browser. The host form shows them in
// this order and runs the format checks before a value is saved.
import type { PluginSettingsHandle } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SETUP_LABELS, type SecretId } from "../shared/constants.js";

// An empty value clears the field, so every check lets "" through. The server
// treats a blank value as absent (see isPresent).
const clearable = (check: z.ZodType<string, string>) => z.union([z.literal(""), check]);
const noWhitespace = (what: string) =>
  clearable(z.string().refine((value) => !/\s/.test(value), `${what} cannot contain spaces.`));
const e164 = clearable(
  z.string().regex(/^\+[1-9]\d{6,14}$/, "Use E.164 format: a plus sign, then the country code and number, like +14155550100."),
);

export const SETUP_FORMATS = {
  openaiKey: noWhitespace("The API key"),
  twilioSid: clearable(z.string().regex(/^AC[0-9a-fA-F]{32}$/, "A Twilio Account SID is AC followed by 32 hex characters.")),
  twilioToken: noWhitespace("The auth token"),
  twilioCallerNumber: e164,
  yourPhoneNumber: e164,
  openaiSipProject: clearable(z.string().regex(/^proj_[A-Za-z0-9]+$/, "An OpenAI project id starts with proj_.")),
} satisfies Record<SecretId, z.ZodType<string, string>>;

export const SETUP_SETTINGS = {
  openaiKey: {
    type: "string",
    secret: true,
    label: SETUP_LABELS.openaiKey,
    description:
      "Needed for every call. Use a real OpenAI API key from a project with GPT-Live access. ChatGPT or Codex subscription tokens do not work.",
    experimental_schema: SETUP_FORMATS.openaiKey,
  },
  twilioSid: {
    type: "string",
    secret: true,
    label: SETUP_LABELS.twilioSid,
    description: "Only for phone calls. From the Twilio console, starts with AC.",
    experimental_schema: SETUP_FORMATS.twilioSid,
  },
  twilioToken: {
    type: "string",
    secret: true,
    label: SETUP_LABELS.twilioToken,
    description: "Only for phone calls. The auth token that belongs to the Account SID above.",
    experimental_schema: SETUP_FORMATS.twilioToken,
  },
  twilioCallerNumber: {
    type: "string",
    secret: true,
    label: SETUP_LABELS.twilioCallerNumber,
    description: "Only for phone calls. A Twilio voice number on this account. Calls to you come from it.",
    experimental_schema: SETUP_FORMATS.twilioCallerNumber,
  },
  yourPhoneNumber: {
    type: "string",
    secret: true,
    label: SETUP_LABELS.yourPhoneNumber,
    description: "Only for phone calls. The number Dispatch dials when you ask for a call.",
    experimental_schema: SETUP_FORMATS.yourPhoneNumber,
  },
  openaiSipProject: {
    type: "string",
    secret: true,
    label: SETUP_LABELS.openaiSipProject,
    description: "Only for phone calls. The OpenAI project that answers SIP calls, starts with proj_. Not a secret, but kept off the browser like the rest.",
    experimental_schema: SETUP_FORMATS.openaiSipProject,
  },
} as const;

export type SetupSettingsHandle = PluginSettingsHandle<typeof SETUP_SETTINGS>;
export type SetupValues = Awaited<ReturnType<SetupSettingsHandle["get"]>>;

/** A setup field counts as present when it has a non-blank value. */
export const isPresent = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

/** Shown in the plugin page banner and in `bb plugin list` when no mode can run. */
export function needsKeyMessage(): string {
  return (
    "Dispatch needs an OpenAI API key before it can take a call. " +
    "Add it in Dispatch settings, first field (In-app voice — OpenAI API key), " +
    "or run `bb plugin config dispatch set openaiKey <key>`. Phone calls are optional and never block this."
  );
}
