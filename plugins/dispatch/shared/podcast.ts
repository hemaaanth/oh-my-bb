import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { deviceProfileSchema } from "./contract.js";

export const PODCAST_ROSTER_CHANNEL = "podcast-roster";
export const PODCAST_SPEECH_CHANNEL = "podcast-speech";
export const PODCAST_VOICES = ["marin", "cedar", "coral", "ash", "sage", "verse", "ballad", "echo", "alloy", "nova", "onyx", "shimmer", "fable"] as const;
export const profileSchema = z.object({
  projectId: z.string().min(1), name: z.string().trim().min(1).max(60),
  voice: z.enum(PODCAST_VOICES), enabled: z.boolean(),
  personality: z.string().trim().max(800), topics: z.string().trim().max(500),
}).strict();
export type PodcastProfile = z.infer<typeof profileSchema>;
export const speechSchema = z.object({
  id: z.string(), projectId: z.string().nullable(), speaker: z.string(), text: z.string(),
  updateId: z.string().nullable(),
});
export type PodcastSpeech = z.infer<typeof speechSchema>;
const session = { callId: z.string(), token: z.string() };
const ok = z.object({ ok: z.literal(true) });
export const podcastContract = defineRpcContract({
  podcastProfiles: { input: z.object({}), output: z.object({ profiles: z.array(profileSchema) }) },
  podcastProfileSave: { input: profileSchema, output: profileSchema },
  podcastOpen: {
    input: z.object({ sdp: z.string().min(1).max(100_000), nonce: z.string(), clientId: z.string(), device: deviceProfileSchema }),
    output: z.object({ ...session, sdp: z.string() }),
  },
  podcastTurn: {
    input: z.object({ ...session, requestId: z.string().min(1).max(100), text: z.string().trim().min(1).max(8000), projectId: z.string().nullable(), threadId: z.string().nullable().default(null) }),
    output: z.object({ speeches: z.array(speechSchema), hold: z.boolean() }),
  },
  podcastHeartbeat: { input: z.object(session), output: ok },
  podcastClose: { input: z.object(session), output: ok },
  podcastCancel: { input: z.object(session), output: ok },
  podcastUpdates: {
    input: z.object(session), output: z.object({ speeches: z.array(speechSchema), pending: z.number(), hold: z.boolean() }),
  },
  podcastSpeaking: { input: z.object({ ...session, speechId: z.string() }), output: ok },
  podcastHeard: { input: z.object({ ...session, speechId: z.string() }), output: ok },
  podcastAudio: {
    input: z.object({ ...session, speechId: z.string() }),
    output: z.object({ audio: z.string(), mime: z.literal("audio/mpeg") }),
  },
});
export type PodcastContract = typeof podcastContract;
