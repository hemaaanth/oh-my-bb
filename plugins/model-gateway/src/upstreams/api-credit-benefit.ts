import { z } from "zod";
import { apiCreditBenefitSchema, type ApiCreditBenefit } from "../contracts.js";

const endpoint = "https://api.anthropic.com";
const usd = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/u)]).transform(Number).pipe(z.number().nonnegative());
const payloadSchema = z.object({
  status: z.string(),
  link: z.object({ console_org: z.object({ id: z.string().uuid(), name: z.string().min(1) }) }).nullish(),
  monthly_credit_usd: usd.nullish(),
  next_grant_at: z.string().datetime({ offset: true }).nullish(),
  grants_held_reason: z.string().nullish(),
});

export function parseApiCreditBenefit(payload: unknown): ApiCreditBenefit | null {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.status !== "linked") return null;
  const { link, monthly_credit_usd, next_grant_at, grants_held_reason } = parsed.data;
  if (link == null || monthly_credit_usd == null) return null;
  return apiCreditBenefitSchema.parse({ organizationId: link.console_org.id,
    organizationName: link.console_org.name, monthlyUsd: monthly_credit_usd,
    nextGrantAt: next_grant_at == null ? null : Date.parse(next_grant_at),
    heldReason: grants_held_reason ?? null });
}

/** Billing rejects OAuth. Verify the web session belongs to the OAuth account before reading its benefit. */
export async function fetchApiCreditBenefit(fetcher: typeof fetch, accessToken: string, sessionKey: string): Promise<ApiCreditBenefit | null> {
  async function get(path: string, headers: Record<string, string>): Promise<unknown> {
    const response = await fetcher(endpoint + path, { headers: { ...headers, accept: "application/json" },
      signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Claude Billing request failed (HTTP ${response.status}). Renew the Billing session.`); }
    return response.json();
  }
  const profile = z.object({ account: z.object({ uuid: z.string().uuid() }),
    organization: z.object({ uuid: z.string().uuid() }) }).parse(await get("/api/oauth/profile", {
    authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20",
  }));
  const headers = { cookie: `sessionKey=${sessionKey}` };
  const account = z.object({ uuid: z.string().uuid() }).parse(await get("/api/account", headers));
  if (account.uuid !== profile.account.uuid) throw new Error("Billing session belongs to a different Claude account.");
  return parseApiCreditBenefit(await get(`/api/quirky-lollipop/link-state?organization_uuid=${profile.organization.uuid}&include_candidates=false`, headers));
}

/** Only unexpired subscription grants count; purchased and other promotional credits do not. */
export function parseSubscriptionCreditRemaining(payload: unknown, now = Date.now()): number | null {
  const parsed = z.object({ promo_tranches: z.array(z.unknown()) }).safeParse(payload);
  if (!parsed.success) return null;
  let remaining = 0;
  for (const value of parsed.data.promo_tranches) {
    if (typeof value !== "object" || value === null || !("program_id" in value) || value.program_id !== "subscription_api_credit") continue;
    const grant = z.object({ currency: z.literal("USD"),
      expires_at: z.string().datetime({ offset: true }).nullable(),
      remaining_amount_minor_units: z.number().nonnegative(),
      granted_amount_minor_units: z.number().nonnegative(),
      remaining: z.object({ credits: z.object({ amount_minor: z.number().nonnegative(), exponent: z.number().int().min(0).max(6) }) }).nullish(),
    }).safeParse(value);
    if (!grant.success) return null;
    const g = grant.data;
    if (g.expires_at !== null && Date.parse(g.expires_at) <= now) continue;
    if (g.remaining_amount_minor_units > g.granted_amount_minor_units) return null;
    remaining += g.remaining?.credits == null ? g.remaining_amount_minor_units / 100 : g.remaining.credits.amount_minor / 10 ** g.remaining.credits.exponent;
  }
  return remaining;
}

export async function fetchSubscriptionCreditRemaining(fetcher: typeof fetch, sessionKey: string, organizationId: string): Promise<number | null> {
  z.string().uuid().parse(organizationId);
  const response = await fetcher(`${endpoint}/api/organizations/${organizationId}/prepaid/credits`, {
    headers: { cookie: `sessionKey=${sessionKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Claude subscription balance unavailable (HTTP ${response.status}). Renew the Console session.`); }
  return parseSubscriptionCreditRemaining(await response.json());
}
