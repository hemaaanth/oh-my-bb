// Short device names: "Mac", "iPhone", "Phone". The app adds one to its device
// profile. The server derives one for older call rows that have none.
import type { DeviceProfile } from "./contract.js";

/** Browsers do not expose the device's own name, so this is the kind of device. */
const DEVICE_NAMES: Readonly<Record<string, string>> = {
  iOS: "iPhone",
  iPadOS: "iPad",
  macOS: "Mac",
  Windows: "Windows PC",
  ChromeOS: "Chromebook",
  Linux: "Linux PC",
};

export function deviceNameOf(platform: string, mobile: boolean): string | undefined {
  if (platform === "Android") return mobile ? "Android phone" : "Android tablet";
  return DEVICE_NAMES[platform];
}

/** The short name for a call's device, or null when it is unknown. */
export function shortDeviceName(device: DeviceProfile, channel: "app" | "phone"): string | null {
  if (channel === "phone" || device.runtime === "sip") return "Phone";
  return device.deviceName ?? deviceNameOf(device.platform, device.mobile) ?? null;
}
