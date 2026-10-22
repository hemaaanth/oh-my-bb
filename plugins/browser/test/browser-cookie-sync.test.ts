import { describe, expect, it } from "vitest";
import { cookieState } from "../src/browser-cookies.js";
const cookie = { name: "sid", value: "private-cookie", domain: ".example.com", path: "/", secure: true, httpOnly: true, session: true, sameSite: "lax" };

describe("live cookie snapshots", () => {
  it("keeps session and HttpOnly cookies and reports skipped partitions", () => {
    expect(cookieState({ cookies: [cookie, { ...cookie, partitionKey: { topLevelSite: "https://example.org", hasCrossSiteAncestor: true } }] }))
      .toMatchObject({ bbCookieSync: true, skippedPartitioned: 1, cookies: [{ value: "private-cookie", expires: -1, httpOnly: true, sameSite: "Lax" }] });
  });
  it("normalizes an empty store so deleting the last cookie propagates", () => {
    expect(cookieState({ cookies: [] })).toMatchObject({ cookies: [], origins: [], bbCookieSync: true });
  });
  it("rejects malformed snapshots without quoting cookie values", () => {
    for (const value of [null, {}, { cookies: "private-cookie" }, { cookies: [{ value: "private-cookie" }] }]) {
      expect(() => cookieState(value)).toThrow(/Invalid/);
      try { cookieState(value); } catch (error) { expect(String(error)).not.toContain("private-cookie"); }
    }
  });
});
