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

/** Calendar-day keys, without UTC conversion (usage is reported by local day). */
export function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatCallWhen(at: number, now = Date.now()): string {
  const date = new Date(at);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const day = dayKey(at) === dayKey(now) ? "Today" : dayKey(at) === dayKey(yesterday.getTime()) ? "Yesterday" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export const firstLine = (text: string): string => text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
