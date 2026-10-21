import { expect, it } from "vitest";
import { CreditGrants } from "./credit-grants.js";

it("binds approval to one thread and account and counts attempts before dispatch", () => {
  let now = 0;
  const grants = new CreditGrants(() => now);
  expect(grants.acquire("thread", "account")).toBeNull();
  grants.grant("thread", "account");
  expect(grants.acquire("fork", "account")).toBeNull();
  expect(grants.acquire("thread", "other")).toBeNull();
  const release = grants.acquire("thread", "account")!;
  expect(grants.status("thread").grant?.remaining).toBe(9);
  expect(grants.acquire("thread", "account")).toBeNull();
  expect(() => grants.grant("thread", "other")).toThrow(/finish/);
  release();
  for (let i = 0; i < 9; i++) grants.acquire("thread", "account")!();
  expect(grants.acquire("thread", "account")).toBeNull();
  grants.grant("thread", "account");
  now = 15 * 60_000;
  expect(grants.acquire("thread", "account")).toBeNull();
  grants.grant("thread", "account");
  grants.revoke("thread");
  expect(grants.acquire("thread", "account")).toBeNull();
});
