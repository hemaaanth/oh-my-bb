import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "amber",
  "brisk",
  "calm",
  "clear",
  "cobalt",
  "coral",
  "crisp",
  "dawn",
  "ember",
  "fresh",
  "golden",
  "jade",
  "lilac",
  "lunar",
  "mellow",
  "mint",
  "navy",
  "quiet",
  "silver",
  "solar",
  "swift",
  "velvet",
  "violet",
  "warm",
] as const;

const NOUNS = [
  "atlas",
  "bloom",
  "brook",
  "cedar",
  "cloud",
  "comet",
  "cove",
  "field",
  "forest",
  "garden",
  "glade",
  "harbor",
  "island",
  "meadow",
  "moon",
  "orbit",
  "pine",
  "river",
  "shore",
  "spark",
  "stone",
  "trail",
  "valley",
  "willow",
] as const;

export function generateAccessCode(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  const digits = randomInt(10_000).toString().padStart(4, "0");
  return `${adjective}-${noun}-${digits}`;
}
