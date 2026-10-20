// Custom voices made with OpenAI prompt-to-voice. The key goes only into the
// Authorization header. OpenAI has no documented delete, so removing a voice
// takes it off Dispatch's list and leaves it in the OpenAI organisation.
import { CUSTOM_VOICE_NAME_MAX, CUSTOM_VOICE_PREFIX, CUSTOM_VOICE_PROMPT_MAX, ENDPOINTS, defaultPreferences } from "../../shared/constants.js";
import type { Preferences } from "../../shared/contract.js";
import type { ServerContext } from "../context.js";
import { OPENAI_ERROR_MAX, openaiKey } from "../live-session.js";
import { readPreferences, writePreferences } from "../preferences.js";

export const VOICES_SCOPE_ERROR =
  "Your OpenAI key cannot create voices. Give it the api.voices.write permission, or use a key with all permissions.";
export const VOICES_ACCESS_ERROR = "Your OpenAI project cannot use custom voices. Check its GPT-Live and custom voice access.";

async function createFailure(response: Response): Promise<Error> {
  const text = (await response.text().catch(() => "")).trim();
  if ((response.status === 401 || response.status === 403) && /api\.voices\.write|scope|permission/i.test(text)) {
    return new Error(VOICES_SCOPE_ERROR);
  }
  if (response.status === 404) return new Error(VOICES_ACCESS_ERROR);
  const body = text.slice(0, OPENAI_ERROR_MAX);
  return new Error(`OpenAI ${response.status}${body ? `: ${body}` : ""}`);
}

/** Create a voice from a description and add it to the list. The chosen voice does not change. */
export async function createCustomVoice(ctx: ServerContext, input: { name: string; prompt: string }): Promise<Preferences> {
  const name = input.name.trim().slice(0, CUSTOM_VOICE_NAME_MAX);
  const prompt = input.prompt.trim();
  if (name === "") throw new Error("Give the voice a name.");
  if (prompt === "") throw new Error("Describe the voice.");
  if (prompt.length > CUSTOM_VOICE_PROMPT_MAX) throw new Error(`Keep the description under ${CUSTOM_VOICE_PROMPT_MAX} characters.`);
  const key = await openaiKey(ctx);
  const response = await fetch(ENDPOINTS.voices, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", name, prompt, model: "auto" }),
  });
  if (!response.ok) throw await createFailure(response);
  const created = (await response.json().catch(() => ({}))) as { id?: unknown; name?: unknown; prompt?: unknown; created_at?: unknown };
  if (typeof created.id !== "string" || !created.id.startsWith(CUSTOM_VOICE_PREFIX)) {
    throw new Error("OpenAI created the voice but did not return its id.");
  }
  const createdAt = typeof created.created_at === "number" ? new Date(created.created_at * 1000) : new Date();
  const current = await readPreferences(ctx);
  return writePreferences(ctx, {
    customVoices: [
      ...current.customVoices,
      {
        id: created.id,
        name: typeof created.name === "string" && created.name.trim() !== "" ? created.name : name,
        prompt: typeof created.prompt === "string" && created.prompt.trim() !== "" ? created.prompt : prompt,
        createdAt: createdAt.toISOString(),
      },
    ],
  });
}

/** Take a voice off the list. When it was the chosen voice, the default voice takes its place. */
export async function removeCustomVoice(ctx: ServerContext, input: { id: string }): Promise<Preferences> {
  const current = await readPreferences(ctx);
  return writePreferences(ctx, {
    customVoices: current.customVoices.filter((voice) => voice.id !== input.id),
    ...(current.voice === input.id ? { voice: defaultPreferences().voice } : {}),
  });
}
