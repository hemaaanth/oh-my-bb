// The realm's device profile (SPEC §4). It goes with every call start so the
// Console can show where a call ran, and it decides whether the realm may
// change screens during a call.

import type { DeviceProfile } from "@/shared/contract.js";

/** What detection reads. Tests pass their own; the app passes the browser. */
export interface DeviceEnv {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** Display modes the page matches, from `matchMedia("(display-mode: …)")`. */
  displayMode?: string;
  /** iOS Safari's home-screen flag. */
  standalone?: boolean;
  /** A WebKit message bridge, as native iOS apps install. */
  webkitBridge?: boolean;
}

const DISPLAY_MODES = ["fullscreen", "standalone", "minimal-ui"] as const;

export function browserDeviceEnv(): DeviceEnv {
  if (typeof navigator === "undefined") return { userAgent: "" };
  const nav = navigator as Navigator & { standalone?: boolean; userAgentData?: { platform?: string } };
  const match = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? DISPLAY_MODES.find((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)
    : undefined;
  const webkit = typeof window !== "undefined"
    ? (window as Window & { webkit?: { messageHandlers?: unknown } }).webkit
    : undefined;
  return {
    userAgent: nav.userAgent ?? "",
    platform: nav.userAgentData?.platform ?? nav.platform ?? "",
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    displayMode: match ?? "browser",
    standalone: nav.standalone === true,
    webkitBridge: Boolean(webkit?.messageHandlers),
  };
}

function platformOf(env: DeviceEnv): { platform: string; mobile: boolean } {
  const ua = env.userAgent;
  const hint = env.platform ?? "";
  if (/iPhone|iPod/.test(ua)) return { platform: "iOS", mobile: true };
  if (/iPad/.test(ua)) return { platform: "iPadOS", mobile: true };
  // iPadOS Safari sends a Mac user agent. Touch points give it away.
  if ((/Macintosh/.test(ua) || /^Mac/.test(hint)) && (env.maxTouchPoints ?? 0) > 1) return { platform: "iPadOS", mobile: true };
  if (/Android/.test(ua)) return { platform: "Android", mobile: /Mobile|Android/.test(ua) };
  if (/Macintosh|Mac OS X/.test(ua) || /^mac/i.test(hint)) return { platform: "macOS", mobile: false };
  if (/Windows/.test(ua) || /^win/i.test(hint)) return { platform: "Windows", mobile: false };
  if (/CrOS/.test(ua)) return { platform: "ChromeOS", mobile: false };
  if (/Linux/.test(ua) || /linux/i.test(hint)) return { platform: "Linux", mobile: false };
  return { platform: hint || "Unknown", mobile: /Mobi/.test(ua) };
}

function browserOf(ua: string): string {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (/CriOS\/|Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  if (/AppleWebKit/.test(ua)) return "WebKit";
  return "Browser";
}

export function detectDeviceProfile(env: DeviceEnv): DeviceProfile {
  const { platform, mobile } = platformOf(env);
  const displayMode = env.standalone && (!env.displayMode || env.displayMode === "browser") ? "standalone" : env.displayMode || "browser";
  const nativeWebview = Boolean(env.webkitBridge) && /AppleWebKit/.test(env.userAgent) && !/Safari\//.test(env.userAgent);
  const runtime: DeviceProfile["runtime"] = nativeWebview ? "native-webview" : displayMode === "browser" ? "browser" : "pwa";
  const browser = nativeWebview ? "WebView" : browserOf(env.userAgent);
  const where = runtime === "pwa" ? "app" : runtime === "native-webview" ? "native app" : mobile ? "mobile" : "desktop";
  return { platform, mobile, browser, displayMode, runtime, label: `${platform} · ${browser} (${where})` };
}

/**
 * Can this realm switch screens without losing the call? iOS native webviews
 * open the destination in another webview and freeze the call's realm, so
 * they keep the call's screen and use the drawer (SPEC §4, §9.4).
 */
export function canNavigate(profile: Pick<DeviceProfile, "mobile" | "runtime">): boolean {
  return !(profile.mobile && profile.runtime === "native-webview");
}

let captured: DeviceProfile | null = null;

/** The profile is read once per realm. */
export function deviceProfile(): DeviceProfile {
  captured ??= detectDeviceProfile(browserDeviceEnv());
  return captured;
}
