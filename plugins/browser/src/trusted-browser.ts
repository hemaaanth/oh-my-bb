/** Browser-owned identity payload. Sandboxes owns machine eligibility and delivery. */
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserSettings } from "./config.js";

export type TrustedBrowserSettings = Pick<
  BrowserSettings,
  | "browserUserAgent"
  | "browserExitNode"
  | "browserHomeEgressIp"
  | "browserTailscaleAuthKey"
  | "browserTailscaleAuthKeyFile"
  | "browserStateFile"
> & Partial<Pick<BrowserSettings, "homeRouting" | "sharePersonalLogins">>;

export interface TrustedBrowserPayload {
  userAgent: string;
  egress: "home" | "direct";
  exitNode: string;
  homeEgressIp: string;
  /** Native sandbox machines do not replay the Docker entrypoint that exports IS_SANDBOX. */
  tailscaleUserspace: "1";
  tailscaleAuthKey: string;
  /** State that must be present before bb-browser starts without an explicit choice. */
  requiredState: string;
  /** Content for the default state; null removes an earlier provisioned one. */
  state: string | null;
}

export const NO_TRUSTED_BROWSER: TrustedBrowserSettings = {
  browserUserAgent: "",
  browserExitNode: "",
  browserHomeEgressIp: "",
  browserTailscaleAuthKey: "",
  browserTailscaleAuthKeyFile: "",
  browserStateFile: "",
};

const MAX_STATE_BYTES = 5 * 1024 * 1024;

function expandHome(file: string): string {
  if (file === "~") return os.homedir();
  if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
  return file;
}

function dotenvValue(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) return trimmed.slice(1, -1);
  return trimmed;
}

export async function trustedBrowserPayload(
  settings: TrustedBrowserSettings,
): Promise<{ payload: TrustedBrowserPayload; warnings: string[] }> {
  const warnings: string[] = [];
  let tailscaleAuthKey = settings.browserTailscaleAuthKey.trim();
  const authKeyFile = settings.browserTailscaleAuthKeyFile.trim();
  if (tailscaleAuthKey === "" && authKeyFile !== "") {
    const file = expandHome(authKeyFile);
    try {
      const info = await stat(file);
      if ((info.mode & 0o077) !== 0) {
        warnings.push(`Trusted browser Tailscale auth key file ${file} is not mode 0600; not imported`);
      } else if (info.size > 16 * 1024) {
        warnings.push(`Trusted browser Tailscale auth key file ${file} is too large; not imported`);
      } else {
        const text = await readFile(file, "utf8");
        const line = text.split(/\r?\n/).find((entry) => entry.startsWith("TAILSCALE_AUTH_KEY="));
        tailscaleAuthKey = line ? dotenvValue(line.slice("TAILSCALE_AUTH_KEY=".length)) : "";
        if (tailscaleAuthKey === "") {
          warnings.push(`Trusted browser Tailscale auth key file ${file} has no TAILSCALE_AUTH_KEY; not imported`);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
      warnings.push(`Trusted browser Tailscale auth key file ${file} could not be read (${code}); not imported`);
    }
  }
  const payload: TrustedBrowserPayload = {
    userAgent: settings.browserUserAgent,
    egress: settings.homeRouting === false ? "direct" : "home",
    exitNode: settings.homeRouting === false ? "" : settings.browserExitNode.trim(),
    homeEgressIp: settings.homeRouting === false ? "" : settings.browserHomeEgressIp.trim(),
    tailscaleUserspace: "1",
    tailscaleAuthKey,
    requiredState: "",
    state: null,
  };
  const stateFile = settings.sharePersonalLogins === false ? "" : settings.browserStateFile.trim();
  if (stateFile !== "") {
    // Even if the file cannot be read, the sandbox must know a state was
    // expected, so bb-browser refuses to start signed out instead of guessing.
    payload.requiredState = "default";
    const file = expandHome(stateFile);
    try {
      const info = await stat(file);
      if (info.size > MAX_STATE_BYTES) {
        warnings.push(`Trusted browser state file is larger than ${MAX_STATE_BYTES} bytes; not imported`);
      } else {
        payload.state = await readFile(file, "utf8");
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
      warnings.push(`Trusted browser state file ${file} could not be read (${code}); not imported`);
    }
  }
  return { payload, warnings };
}

