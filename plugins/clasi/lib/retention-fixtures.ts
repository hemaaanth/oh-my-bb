// Synthetic boundary cases, kept local so Clasi tests run without Pinpoint.
export const CLASI_RULES_FIXTURES = {
  safeKey: {
    accept: ["brand-voice", "spacing.scale", "cta_wording", "a", "nav-2-columns", "k".repeat(80)],
    reject: ["", "Brand-Voice", "-leading-dash", "trailing-", "double--dash", "has space", "k".repeat(81)],
  },
  safeText: {
    accept: ["Use a four pixel spacing scale.", "Prefer sentence case in button labels", "Error copy states the fix, not the failure", "t".repeat(240)],
    reject: ["", "line one\nline two", "line one\rline two", "Fix the spacing in /src/components/Button.tsx", "See C:\\Users\\style-guide.md for details", "token=synthetic-test-value", "password: synthetic-test-value", "-----BEGIN RSA PRIVATE KEY-----", "Rotate " + "AKIA" + "1234567890ABCDEF quarterly", "Use " + "sk-" + "a".repeat(26) + " for tests", "t".repeat(241)],
  },
} as const;

export const CLASI_SCOPE_FIXTURES = {
  scopeRemotes: [
    { remote: "https://github.com/example/project.git", canonical: "github.com/example/project" },
    { remote: "git@github.com:example/project.git", canonical: "github.com/example/project" },
    { remote: "ssh://git@git.example.org:2222/team/widget.git/", canonical: "git.example.org:2222/team/widget" },
  ],
} as const;
