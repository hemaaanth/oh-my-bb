import { z } from "zod";
import type { Account, ApiSpend } from "../contracts.js";

const BOUNDLESS_ROOT = "https://api.inference.boundless.network";
const boundlessCredits = z.object({
  object: z.literal("credits"),
  currency: z.literal("usd"),
  balance: z.number().nullable(),
  key: z.object({
    spent: z.number().nonnegative(),
    limit: z.number().nonnegative().nullable(),
  }),
});

export function supportsApiSpend(account: Account): boolean {
  return account.kind === "api-key" &&
    (account.baseUrl === BOUNDLESS_ROOT || account.baseUrl === `${BOUNDLESS_ROOT}/v1`);
}

export async function fetchApiSpend(
  request: typeof fetch,
  apiKey: string,
  now: () => number,
): Promise<ApiSpend | null> {
  const response = await request(`${BOUNDLESS_ROOT}/v1/credits`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const parsed = boundlessCredits.safeParse(await response.json());
  if (!parsed.success) return null;
  const { balance, key } = parsed.data;
  return { balanceUsd: balance, keySpentUsd: key.spent, keyLimitUsd: key.limit, observedAt: now() };
}
