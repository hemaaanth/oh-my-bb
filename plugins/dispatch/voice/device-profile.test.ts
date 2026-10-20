import { describe, expect, it } from "vitest";
import { canNavigate, detectDeviceProfile } from "./device-profile.js";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  iosWebview: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
};

describe("detectDeviceProfile", () => {
  it("counts an iPad with a desktop user agent and touch points as mobile", () => {
    const profile = detectDeviceProfile({ userAgent: UA.ipadDesktop, platform: "MacIntel", maxTouchPoints: 5 });
    expect(profile).toMatchObject({ platform: "iPadOS", mobile: true, browser: "Safari", runtime: "browser" });
    expect(detectDeviceProfile({ userAgent: UA.ipadDesktop, platform: "MacIntel", maxTouchPoints: 0 }).mobile).toBe(false);
  });

  it("reads Android Chrome as a mobile browser", () => {
    expect(detectDeviceProfile({ userAgent: UA.android })).toMatchObject({
      platform: "Android", mobile: true, browser: "Chrome", displayMode: "browser", runtime: "browser",
    });
  });

  it("reads a standalone display mode as a PWA", () => {
    expect(detectDeviceProfile({ userAgent: UA.iphone, displayMode: "standalone" })).toMatchObject({ runtime: "pwa", displayMode: "standalone" });
    expect(detectDeviceProfile({ userAgent: UA.iphone, standalone: true })).toMatchObject({ runtime: "pwa", displayMode: "standalone" });
  });

  it("reads a WebKit bridge without Safari as a native webview", () => {
    const profile = detectDeviceProfile({ userAgent: UA.iosWebview, webkitBridge: true });
    expect(profile).toMatchObject({ platform: "iOS", mobile: true, runtime: "native-webview", browser: "WebView" });
    expect(canNavigate(profile)).toBe(false);
    // Safari itself has no bridge, so it stays a browser.
    expect(detectDeviceProfile({ userAgent: UA.iphone }).runtime).toBe("browser");
  });

  it("composes the label from platform, browser and where it runs", () => {
    expect(detectDeviceProfile({ userAgent: UA.iphone }).label).toBe("iOS · Safari (mobile)");
    expect(detectDeviceProfile({ userAgent: UA.mac, platform: "MacIntel" }).label).toBe("macOS · Chrome (desktop)");
    expect(detectDeviceProfile({ userAgent: UA.iphone, displayMode: "standalone" }).label).toBe("iOS · Safari (app)");
    expect(detectDeviceProfile({ userAgent: UA.iosWebview, webkitBridge: true }).label).toBe("iOS · WebView (native app)");
  });

  it("adds the caller's time zone and a short device name", () => {
    expect(detectDeviceProfile({ userAgent: UA.iphone, timeZone: "Europe/Berlin" })).toMatchObject({ timeZone: "Europe/Berlin", deviceName: "iPhone" });
    expect(detectDeviceProfile({ userAgent: UA.mac, platform: "MacIntel" })).toMatchObject({ deviceName: "Mac" });
    expect(detectDeviceProfile({ userAgent: UA.mac, platform: "MacIntel" })).not.toHaveProperty("timeZone");
  });
});

describe("canNavigate", () => {
  it("is false only for a mobile native webview", () => {
    expect(canNavigate({ mobile: false, runtime: "browser" })).toBe(true);
    expect(canNavigate({ mobile: true, runtime: "browser" })).toBe(true);
    expect(canNavigate({ mobile: true, runtime: "pwa" })).toBe(true);
    expect(canNavigate({ mobile: true, runtime: "native-webview" })).toBe(false);
  });
});
