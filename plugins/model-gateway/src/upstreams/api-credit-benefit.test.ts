import { createClaudeAdapter } from "./claude-adapter.js";
import type { AdapterSecretContext } from "./provider-adapter.js";
import { describe, expect, it, vi } from "vitest";
import { fetchApiCreditBenefit, parseApiCreditBenefit, parseSubscriptionCreditGrants, parseSubscriptionCreditRemaining, fetchSubscriptionCreditGrants, withCreditGrants } from "./api-credit-benefit.js";
const account = "11111111-1111-4111-8111-111111111111";
const org = "22222222-2222-4222-8222-222222222222";
const payload = { status: "linked", link: { console_org: { id: org, name: "Example" } }, monthly_credit_usd: "200.00", next_grant_at: "2026-11-12T06:07:21Z", grants_held_reason: null };
describe("subscription API credit benefit", () => {
  it("reads Billing amounts in dollars and the next grant date", () => {
    expect(parseApiCreditBenefit(payload)).toEqual({ organizationId: org, organizationName: "Example", monthlyUsd: 200, remainingUsd: null, nextGrantAt: Date.parse(payload.next_grant_at), heldReason: null, grants: [] });
  });
  it.each([{}, { ...payload, status: "unlinked" }, { ...payload, monthly_credit_usd: "bad" }, { ...payload, next_grant_at: "bad" }])("rejects unknown or malformed benefit data", (value) => {
    expect(parseApiCreditBenefit(value)).toBeNull();
  });
  it("accepts a zero amount, holds, and an unknown next date", () => {
    expect(parseApiCreditBenefit({ ...payload, monthly_credit_usd: "0", next_grant_at: null, grants_held_reason: "past_due" }))
      .toMatchObject({ monthlyUsd: 0, nextGrantAt: null, heldReason: "past_due" });
  });
  it("checks ownership and sends the web session only to Billing endpoints", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ account: { uuid: account }, organization: { uuid: org } }))
      .mockResolvedValueOnce(Response.json({ uuid: account })).mockResolvedValueOnce(Response.json(payload));
    expect(await fetchApiCreditBenefit(fetcher, "oauth", "web-session")).toMatchObject({ monthlyUsd: 200 });
    expect(fetcher.mock.calls[0]?.[1].headers).not.toHaveProperty("cookie");
    expect(fetcher.mock.calls[1]?.[1].headers).not.toHaveProperty("authorization");
    expect(fetcher.mock.calls[2]?.[0]).toContain(`organization_uuid=${org}`);
  });
  it("names Billing's reason when the benefit is not linked yet", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ account: { uuid: account }, organization: { uuid: org } }))
      .mockResolvedValueOnce(Response.json({ uuid: account }))
      .mockResolvedValueOnce(Response.json({ status: "ineligible", reason: "tenure_pending", eligible_from: "2026-11-17T05:43:46Z" }));
    await expect(fetchApiCreditBenefit(fetcher, "oauth", "web-session"))
      .rejects.toThrow("No linked subscription API credit benefit: ineligible (tenure_pending), eligible from 2026-11-17T05:43:46.000Z.");
  });
  it("refuses another account's session before reading the benefit", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ account: { uuid: account }, organization: { uuid: org } }))
      .mockResolvedValueOnce(Response.json({ uuid: org }));
    await expect(fetchApiCreditBenefit(fetcher, "oauth", "web-session")).rejects.toThrow("different Claude account");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("preserves the Billing session when Gateway refreshes OAuth", async () => {
    const writeSecret = vi.fn().mockResolvedValue(undefined);
    const adapter = createClaudeAdapter({ refreshUrl: "https://example.com/token", usageUrl: "https://example.com/usage", profileUrl: "https://example.com/profile" });
    const result = await adapter.refreshSecret({ account: { id: account },
      secret: { kind: "oauth", accessToken: "old", refreshToken: "refresh", expiresAt: 1, billingSessionKey: "web-session", billingConsoleSessionKey: "console-session" },
      accounts: { writeSecret }, now: () => 1000, forceRefresh: true,
      fetch: vi.fn().mockResolvedValue(Response.json({ access_token: "new", expires_in: 3600 })),
    } as unknown as AdapterSecretContext);
    expect(result.secret).toMatchObject({ accessToken: "new", billingSessionKey: "web-session", billingConsoleSessionKey: "console-session" });
    expect(writeSecret).toHaveBeenCalledWith(account, expect.objectContaining({ billingSessionKey: "web-session", billingConsoleSessionKey: "console-session" }));
  });

  it("reports expired sessions without exposing response bodies", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("secret-body", { status: 401 }));
    await expect(fetchApiCreditBenefit(fetcher, "oauth", "web-session")).rejects.toThrow("HTTP 401");
  });
});

describe("subscription credit balance", () => {
  const grant = { program_id: "subscription_api_credit", currency: "USD", expires_at: "2099-01-01T00:00:00Z", remaining_amount_minor_units: 19821, granted_amount_minor_units: 20000 };
  it("uses only unexpired subscription grants, not the total or purchased credits", () => {
    expect(parseSubscriptionCreditRemaining({ amount: 50000, promo_tranches: [grant,
      { ...grant, program_id: "other_promo" }, { ...grant, expires_at: "2000-01-01T00:00:00Z" }], tranches: [grant] })).toBe(198.21);
  });
  it("honors explicit currency units", () => {
    expect(parseSubscriptionCreditRemaining({ promo_tranches: [{ ...grant, remaining: { credits: { amount_minor: 198210, exponent: 3 } } }] })).toBe(198.21);
  });
  it("distinguishes unavailable, exhausted, and malformed balances", () => {
    expect(parseSubscriptionCreditRemaining({})).toBeNull();
    expect(parseSubscriptionCreditRemaining({ promo_tranches: [] })).toBe(0);
    expect(parseSubscriptionCreditRemaining({ promo_tranches: [{ ...grant, remaining_amount_minor_units: 0 }] })).toBe(0);
    expect(parseSubscriptionCreditRemaining({ promo_tranches: [{ ...grant, currency: "EUR" }] })).toBeNull();
    expect(parseSubscriptionCreditRemaining({ promo_tranches: [{ ...grant, remaining_amount_minor_units: 30000 }] })).toBeNull();
  });
  it("keeps each overlapping monthly grant, oldest expiry first", () => {
    const older = { ...grant, expires_at: "2098-01-01T00:00:00Z", remaining_amount_minor_units: 18515 };
    const grants = parseSubscriptionCreditGrants({ promo_tranches: [{ ...grant, remaining_amount_minor_units: 20000 }, older] });
    expect(grants).toEqual([
      { grantedUsd: 200, remainingUsd: 185.15, expiresAt: Date.parse("2098-01-01T00:00:00Z") },
      { grantedUsd: 200, remainingUsd: 200, expiresAt: Date.parse("2099-01-01T00:00:00Z") },
    ]);
    const benefit = parseApiCreditBenefit({ status: "linked", link: { console_org: { id: org, name: "Example" } }, monthly_credit_usd: 200 })!;
    expect(withCreditGrants(benefit, grants)).toMatchObject({ remainingUsd: 385.15, grants });
    expect(withCreditGrants(benefit, null)).toMatchObject({ remainingUsd: null, grants: [] });
  });
  it("reads only the benefit's linked Console organization", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ promo_tranches: [grant] }));
    expect(await fetchSubscriptionCreditGrants(fetcher, "console-session", org)).toMatchObject([{ remainingUsd: 198.21 }]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://api.anthropic.com/api/organizations/${org}/prepaid/credits`);
    expect(fetcher.mock.calls[0]?.[1].headers.cookie).toBe("sessionKey=console-session");
  });
});
