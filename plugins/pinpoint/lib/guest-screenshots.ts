import { randomBytes } from "node:crypto";
import type { GuestActor } from "./guest-review";
import { SCREENSHOT_UPLOAD_WINDOW_MS } from "./store";

export interface GuestScreenshotGrant extends GuestActor {
  annotationId: string;
  threadId: string;
  url: string;
  token: string;
  expiresAt: number;
}
export class GuestScreenshotGrants {
  private readonly grants = new Map<string, GuestScreenshotGrant>();

  create(input: Omit<GuestScreenshotGrant, "token" | "expiresAt">, now = Date.now()): GuestScreenshotGrant {
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token);
    if (this.grants.size >= 256) this.grants.delete(this.grants.keys().next().value!);
    const grant = { ...input, token: randomBytes(32).toString("hex"), expiresAt: now + SCREENSHOT_UPLOAD_WINDOW_MS };
    this.grants.set(grant.token, grant);
    return grant;
  }
  get(token: string, now = Date.now()): GuestScreenshotGrant | null {
    const grant = this.grants.get(token);
    if (!grant || grant.expiresAt <= now) { this.grants.delete(token); return null; }
    return grant;
  }
  revoke(annotationId: string): void {
    for (const [token, grant] of this.grants) if (grant.annotationId === annotationId) this.grants.delete(token);
  }
  clear(): void { this.grants.clear(); }
}
