import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  validateLearningKey,
  validateLearningText,
  validateProposedLearning,
} from "./clasi-rules";
import {
  CLASI_SCOPE_FIXTURES,
  canonicalGitRemote,
  deriveClasiProjectScope,
} from "./clasi-scope";
const CLASI_RULES_FIXTURES = {
  safeKey: {
    accept: [
      "brand-voice",
      "spacing.scale",
      "cta_wording",
      "a",
      "nav-2-columns",
      "k".repeat(80),
    ],
    reject: [
      "",
      "Brand-Voice",
      "-leading-dash",
      "trailing-",
      "double--dash",
      "has space",
      "k".repeat(81),
    ],
  },
  safeText: {
    accept: [
      "Use a four pixel spacing scale.",
      "Prefer sentence case in button labels",
      "Error copy states the fix, not the failure",
      "t".repeat(240),
    ],
    reject: [
      "",
      "line one\nline two",
      "line one\rline two",
      "Fix the spacing in /src/components/Button.tsx",
      "See C:\\Users\\style-guide.md for details",
      "token=ghp_12345678901234567890",
      "password: hunter2",
      "-----BEGIN RSA PRIVATE KEY-----",
      "Rotate AKIA1234567890ABCDEF quarterly",
      "Use sk-abcdefghijklmnopqrstuvwxyz for tests",
      "t".repeat(241),
    ],
  },
} as const;

describe("Clasi-compatible learning rules", () => {
  it("accepts every safeKey accept fixture", () => {
    for (const key of CLASI_RULES_FIXTURES.safeKey.accept) {
      expect(validateLearningKey(key), key).toEqual({ ok: true });
    }
  });

  it("rejects every safeKey reject fixture with a human-readable reason", () => {
    for (const key of CLASI_RULES_FIXTURES.safeKey.reject) {
      const result = validateLearningKey(key);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("accepts every safeText accept fixture", () => {
    for (const text of CLASI_RULES_FIXTURES.safeText.accept) {
      expect(validateLearningText(text), text).toEqual({ ok: true });
    }
  });

  it("rejects every safeText reject fixture with a human-readable reason", () => {
    for (const text of CLASI_RULES_FIXTURES.safeText.reject) {
      const result = validateLearningText(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("validates a whole proposal: topic gate plus key and text rules", () => {
    expect(
      validateProposedLearning({
        topic: "design",
        logicalKey: "spacing-scale",
        text: "Use a four pixel spacing scale.",
      }),
    ).toEqual({ ok: true });
    const badTopic = validateProposedLearning({
      topic: "engineering",
      logicalKey: "spacing-scale",
      text: "Use a four pixel spacing scale.",
    });
    expect(badTopic.ok).toBe(false);
    if (!badTopic.ok) expect(badTopic.reason).toContain("design|copy");
    const pathText = validateProposedLearning({
      topic: "design",
      logicalKey: "spacing-scale",
      text: "Fix the spacing in /src/components/Button.tsx",
    });
    expect(pathText.ok).toBe(false);
    if (!pathText.ok) expect(pathText.reason).toContain("path");
  });
});

describe("vendored clasi project-scope derivation (parity fixtures)", () => {
  it("canonicalizes each fixture remote exactly like clasi", () => {
    for (const fixture of CLASI_SCOPE_FIXTURES.scopeRemotes) {
      expect(canonicalGitRemote(fixture.remote)).toBe(fixture.canonical);
    }
  });

  it("derives the sha-prefixed scope id clasi's algorithm produces", () => {
    for (const fixture of CLASI_SCOPE_FIXTURES.scopeRemotes) {
      // Clasi's projectScopeRef, computed manually from the fixture.
      const expected = `repo_${createHash("sha256")
        .update(fixture.canonical)
        .digest("hex")
        .slice(0, 32)}`;
      expect(
        deriveClasiProjectScope({ id: "proj-x", gitRemoteUrl: fixture.remote }),
      ).toEqual({ type: "project", id: expected });
    }
  });

  it("gives https and scp remotes of the same repo the same scope id", () => {
    const [https, scp] = CLASI_SCOPE_FIXTURES.scopeRemotes;
    expect(https!.canonical).toBe(scp!.canonical);
    expect(
      deriveClasiProjectScope({ id: "a", gitRemoteUrl: https!.remote }).id,
    ).toBe(deriveClasiProjectScope({ id: "b", gitRemoteUrl: scp!.remote }).id);
  });

  it("falls back to the raw project id when there is no git remote — like clasi", () => {
    expect(deriveClasiProjectScope({ id: "project-1", gitRemoteUrl: null })).toEqual(
      { type: "project", id: "project-1" },
    );
  });
});
