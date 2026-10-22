import type { PodcastSpeech } from "../../shared/podcast.js";

/** Answers belong to a user turn. Updates remain pending until actually heard. */
export class PodcastQueue {
  private items: Array<{ speech: PodcastSpeech; generation: number }> = [];
  private seen = new Set<string>();
  generation = 0;
  interrupt() {
    this.generation++;
    this.items = this.items.filter(item => item.speech.updateId !== null);
  }
  add(speeches: PodcastSpeech[], generation = this.generation) {
    for (const speech of speeches) {
      if (generation !== this.generation && speech.updateId === null) continue;
      if (!this.seen.has(speech.id)) { this.seen.add(speech.id); this.items.push({ speech, generation }); }
    }
  }
  next(hold = false) { return this.items.find(item => item.speech.updateId === null)?.speech ?? (hold ? null : this.items[0]?.speech ?? null); }
  retainProjects(ids: Set<string>) { this.items = this.items.filter(item => item.speech.projectId === null || ids.has(item.speech.projectId)); }
  heard(id: string) { this.items = this.items.filter(item => item.speech.id !== id); }
  clear() { this.items = []; this.seen.clear(); this.generation++; }
  get length() { return this.items.length; }
}

/** Local turn detection for transcription sessions that require explicit commits. */
export class PodcastVad {
  speaking = false;
  private loud = 0;
  private lastSound = 0;
  constructor(private readonly start: () => void, private readonly commit: () => void) {}
  sample(rms: number, now: number) {
    if (rms > 0.025) {
      this.lastSound = now;
      this.loud++;
      if (!this.speaking && this.loud >= 2) { this.speaking = true; this.start(); }
    } else {
      this.loud = 0;
      if (this.speaking && now - this.lastSound >= 750) { this.speaking = false; this.commit(); }
    }
  }
  reset() { this.speaking = false; this.loud = 0; }
}
