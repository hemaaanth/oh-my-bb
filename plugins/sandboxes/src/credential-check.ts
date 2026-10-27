import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SandboxProvider } from "./backend.js";
import type { SandboxSettings } from "./config.js";
import { sandboxProviderCredentialStatus } from "./config.js";

function effectiveSettings(settings: SandboxSettings): SandboxSettings {
  return { ...settings,
    daytonaApiKey: settings.daytonaApiKey?.trim() || process.env.DAYTONA_API_KEY?.trim() || "",
    daytonaApiUrl: settings.daytonaApiUrl?.trim() || process.env.DAYTONA_API_URL?.trim() || "",
    modalTokenId: settings.modalTokenId?.trim() || process.env.MODAL_TOKEN_ID?.trim() || "",
    modalTokenSecret: settings.modalTokenSecret?.trim() || process.env.MODAL_TOKEN_SECRET?.trim() || "",
    e2bApiKey: settings.e2bApiKey?.trim() || process.env.E2B_API_KEY?.trim() || "",
    boxApiKey: settings.boxApiKey?.trim() || process.env.BOX_API_KEY?.trim() || "",
    freestyleApiKey: settings.freestyleApiKey?.trim() || process.env.FREESTYLE_API_KEY?.trim() || "",
  };
}
function identity(provider: SandboxProvider, settings: SandboxSettings) {
  const values = {
    daytona: [settings.daytonaApiKey, settings.daytonaApiUrl],
    modal: [settings.modalTokenId, settings.modalTokenSecret], e2b: [settings.e2bApiKey, process.env.E2B_API_URL, process.env.E2B_DOMAIN],
    box: [settings.boxApiKey], freestyle: [settings.freestyleApiKey],
  }[provider];
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/** One read-only account/list request, only after the owner chooses Check connection. */
export async function checkProviderCredentials(provider: SandboxProvider, settings: SandboxSettings) {
  const signal = AbortSignal.timeout(15_000);
  const request = async (url: string, key: string, header = "Authorization") => {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password) throw new Error("Use an HTTPS provider API URL");
    const response = await fetch(target, { headers: { [header]: header === "Authorization" ? `Bearer ${key}` : key }, redirect: "error", signal });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Provider refused credentials");
  };
  if (provider === "daytona") return request(`${(settings.daytonaApiUrl || "https://app.daytona.io/api").replace(/\/$/, "")}/snapshots?page=1&limit=1`, settings.daytonaApiKey);
  if (provider === "box") return request("https://ascii.dev/api/box/v1/boxes", settings.boxApiKey);
  if (provider === "modal") {
    const { ModalClient } = createRequire(import.meta.url)("modal") as typeof import("modal");
    const client = new ModalClient({ tokenId: settings.modalTokenId, tokenSecret: settings.modalTokenSecret });
    const iterator = client.sandboxes.list();
    const close = () => client.close();
    signal.addEventListener("abort", close, { once: true });
    try { await iterator.next(); } finally { signal.removeEventListener("abort", close); client.close(); }
  } else if (provider === "e2b") {
    // Same read-only list route and auth header as the SDK, without loading it in BB’s source loader.
    return request(`${(process.env.E2B_API_URL || `https://api.${process.env.E2B_DOMAIN || "e2b.app"}`).replace(/\/$/, "")}/v2/sandboxes?limit=1`, settings.e2bApiKey, "X-API-KEY");
  } else {
    const { Freestyle } = await import("freestyle");
    await new Freestyle({ apiKey: settings.freestyleApiKey, fetch: (url, init) => fetch(url, { ...init, redirect: "error", signal }) }).vms.list();
  }
}

export function providerCredentialChecks(bb: BbPluginApi, settings: () => Promise<SandboxSettings>, check = checkProviderCredentials) {
  const key = (provider: SandboxProvider) => `credential-check:${provider}`;
  const read = async (provider: SandboxProvider) => {
    const current = effectiveSettings(await settings());
    if (!sandboxProviderCredentialStatus(current)[provider]) return "missing" as const;
    const receipt = await bb.storage.kv.get<{ identity: string; valid: boolean }>(key(provider));
    if (!receipt || receipt.identity !== identity(provider, current)) return "unchecked" as const;
    return receipt.valid ? "valid" as const : "invalid" as const;
  };
  return { read, verify: async (provider: SandboxProvider) => {
    const current = effectiveSettings(await settings());
    if (!sandboxProviderCredentialStatus(current)[provider]) return "missing" as const;
    const fingerprint = identity(provider, current);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let valid = false;
    try {
      await Promise.race([check(provider, current), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Connection check timed out")), 20_000); })]);
      valid = true;
    } catch { /* Do not expose provider errors, account data or credentials. */ }
    finally { if (timer) clearTimeout(timer); }
    if (fingerprint !== identity(provider, effectiveSettings(await settings()))) return read(provider);
    await bb.storage.kv.set(key(provider), { identity: fingerprint, valid, checkedAt: Date.now() });
    bb.realtime.publish("sandbox-provider-settings", { type: "credentials-checked" });
    return read(provider);
  } };
}
