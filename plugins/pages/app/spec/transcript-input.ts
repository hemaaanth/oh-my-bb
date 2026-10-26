export interface TranscriptLine { speaker: string; text: string; time?: string | number; highlight?: boolean }

/** Speaker-labelled call notes remain distinct from recognizer words and comparison tracks. */
export function isTranscriptLines(value: unknown): value is TranscriptLine[] {
  return Array.isArray(value) && value.every(item => item && typeof item === "object" && typeof item.speaker === "string" && typeof item.text === "string" && item.start === undefined && item.end === undefined && item.words === undefined);
}
