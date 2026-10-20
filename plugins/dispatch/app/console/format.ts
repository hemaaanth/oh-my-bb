// Display helpers shared by the console and the settings history list.

export const formatDateTime = (at: number): string =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const formatClock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** 75 seconds reads "1:15". An hour or more reads "1:02:03". */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Billed time in minutes with one decimal, for example "1.5 min". */
export const formatMinutes = (seconds: number): string => `${(Math.round((seconds / 60) * 10) / 10).toString()} min`;

export const formatUsd = (usd: number): string => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

export const firstLine = (text: string): string => text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
