import { z } from "zod";
import { apiCreditBenefitSchema, type ApiCreditBenefit, type ApiCreditGrant } from "../contracts.js";

const endpoint = "https://api.anthropic.com";
const usd = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/u)]).transform(Number).pipe(z.number().nonnegative());
const payloadSchema = z.object({
  status: z.string(),
  link: z.object({ console_org: z.object({ id: z.string().uuid(), name: z.string().min(1) }) }).nullish(),
  monthly_credit_usd: usd.nullish(),
  next_grant_at: z.string().datetime({ offset: true }).nullish(),
  grants_held_reason: z.string().nullish(),
});

const linkStateSchema = z.object({ status: z.string().regex(/^[a-z_]{1,40}$/u),
  reason: z.string().regex(/^[a-z_]{1,40}$/u).nullish(), eligible_from: z.string().datetime({ offset: true }).nullish() });

/** Names Billing's reason so a not-yet-eligible account does not look like a setup error. */
function unlinkedMessage(payload: unknown): string | null {
  const state = linkStateSchema.safeParse(payload);
  if (!state.success || state.data.status === "linked") return null;
  const { status, reason, eligible_from } = state.data;
  return `No linked subscription API credit benefit: ${status}${reason == null ? "" : ` (${reason})`}${eligible_from == null ? "" : `, eligible from ${new Date(eligible_from).toISOString()}`}.`;
}

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
  const state = await get(`/api/quirky-lollipop/link-state?organization_uuid=${profile.organization.uuid}&include_candidates=false`, headers);
  const unlinked = unlinkedMessage(state);
  if (unlinked !== null) throw new Error(unlinked);
  return parseApiCreditBenefit(state);
}

/** Only unexpired subscription grants count; purchased and other promotional credits do not. Oldest expiry first. */
export function parseSubscriptionCreditGrants(payload: unknown, now = Date.now()): ApiCreditGrant[] | null {
  const parsed = z.object({ promo_tranches: z.array(z.unknown()) }).safeParse(payload);
  if (!parsed.success) return null;
  const grants: ApiCreditGrant[] = [];
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
    const expiresAt = g.expires_at === null ? null : Date.parse(g.expires_at);
    if (expiresAt !== null && expiresAt <= now) continue;
    if (g.remaining_amount_minor_units > g.granted_amount_minor_units) return null;
    grants.push({ grantedUsd: g.granted_amount_minor_units / 100, expiresAt,
      remainingUsd: g.remaining?.credits == null ? g.remaining_amount_minor_units / 100 : g.remaining.credits.amount_minor / 10 ** g.remaining.credits.exponent });
  }
  return grants.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
}

export function parseSubscriptionCreditRemaining(payload: unknown, now = Date.now()): number | null {
  return parseSubscriptionCreditGrants(payload, now)?.reduce((sum, grant) => sum + grant.remainingUsd, 0) ?? null;
}

export async function fetchSubscriptionCreditGrants(fetcher: typeof fetch, sessionKey: string, organizationId: string): Promise<ApiCreditGrant[] | null> {
  z.string().uuid().parse(organizationId);
  const response = await fetcher(`${endpoint}/api/organizations/${organizationId}/prepaid/credits`, {
    headers: { cookie: `sessionKey=${sessionKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Claude subscription balance unavailable (HTTP ${response.status}). Renew the Console session.`); }
  return parseSubscriptionCreditGrants(await response.json());
}

/** Applies a grant list to a benefit: the sum, and each grant for the footer. */
export function withCreditGrants(benefit: ApiCreditBenefit, grants: ApiCreditGrant[] | null): ApiCreditBenefit {
  return { ...benefit, grants: grants ?? [], remainingUsd: grants?.reduce((sum, grant) => sum + grant.remainingUsd, 0) ?? null };
}
