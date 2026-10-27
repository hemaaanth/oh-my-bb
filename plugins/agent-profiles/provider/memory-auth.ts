import { createHmac, timingSafeEqual } from "node:crypto";
export const MEMORY_ENV_NAMES = ["AGENT_MEMORY_URL", "AGENT_MEMORY_KEY", "AGENT_MEMORY_SECRET", "AGENT_MEMORY_MODE", "AGENT_MEMORY_PROFILE"] as const;
export const MEMORY_CLOCK_WINDOW_MS = 120_000;
export function memorySignature(secret: string, time: string, nonce: string, body: string): string {
  return createHmac("sha256", secret).update(`agent-memory-v1\n${time}\n${nonce}\n${body}`).digest("hex");
}
export function validMemorySignature(expected: string, actual: string): boolean {
  return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
