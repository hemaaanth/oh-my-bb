import { describe, expect, it } from "vitest";

import {
  checkProviderHealth,
  usageKeysFor,
  type UsageMachine,
} from "./provider-health";

const HOST = "host_1";

function machine(providers: UsageMachine["providers"]): UsageMachine[] {
  return [{ id: HOST, status: "connected", providers }];
}

describe("usageKeysFor", () => {
  it("keeps the provider id itself", () => {
    expect(usageKeysFor("codex", "gpt-5.6-sol")).toEqual(["codex"]);
  });

  it("adds the account behind an ACP provider's model vendor", () => {
    // The failure this whole module exists for: acp-omp is fine, the Codex
    // subscription paying for its openai-codex models is not.
    expect(usageKeysFor("acp-omp", "openai-codex/gpt-5.6-sol")).toEqual([
      "acp-omp",
      "codex",
    ]);
  });

  it("leaves a vendor with no first-party usage entry unmapped", () => {
    expect(
      usageKeysFor("acp-omp", "wafer-serverless/DeepSeek-V4-Flash"),
    ).toEqual(["acp-omp"]);
  });
});

describe("checkProviderHealth", () => {
  it("blocks a profile whose model vendor account is out of quota", () => {
    const verdict = checkProviderHealth({
      providerId: "acp-omp",
      model: "openai-codex/gpt-5.6-sol",
      hostId: HOST,
      machines: machine([
        {
          id: "codex",
          displayName: "Codex",
          usage: {
            status: "ok",
            windows: [
              {
                label: "Weekly limit",
                usedPercent: 100,
                resetsAt: "2026-09-16T13:50:36.000Z",
              },
            ],
          },
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("weekly limit");
    expect(verdict.ok === false && verdict.reason).toContain("2026-09-16");
  });

  it("allows the same provider when a different vendor pays for the model", () => {
    // Two profiles, one provider, one exhausted account: the text-edit agent
    // kept working through acp-omp while the review agent died.
    expect(
      checkProviderHealth({
        providerId: "acp-omp",
        model: "wafer-serverless/DeepSeek-V4-Flash",
        hostId: HOST,
        machines: machine([
          {
            id: "codex",
            usage: {
              status: "ok",
              windows: [
                { label: "Weekly limit", usedPercent: 100, resetsAt: null },
              ],
            },
          },
        ]),
      }),
    ).toEqual({ ok: true });
  });

  it("allows a provider with quota left", () => {
    expect(
      checkProviderHealth({
        providerId: "claude-code",
        model: "claude-opus-5",
        hostId: HOST,
        machines: machine([
          {
            id: "claude-code",
            usage: {
              status: "ok",
              windows: [
                { label: "Weekly limit", usedPercent: 62, resetsAt: null },
                { label: "Current session", usedPercent: 5, resetsAt: null },
              ],
            },
          },
        ]),
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    ["unauthenticated", "not signed in"],
    ["expired", "expired"],
    ["not_installed", "not installed"],
  ] as const)("blocks a provider that is %s", (status, expected) => {
    const verdict = checkProviderHealth({
      providerId: "acp-cursor",
      model: "auto",
      hostId: HOST,
      machines: machine([
        { id: "acp-cursor", displayName: "Cursor", usage: { status } },
      ]),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(expected);
  });

  it.each([
    [
      "the usage probe itself failed",
      machine([
        { id: "codex", usage: { status: "error", message: "probe timed out" } },
      ]),
    ],
    ["the provider has no usage data", machine([{ id: "codex", usage: null }])],
    ["the provider is not in the snapshot", machine([])],
    [
      "the machine is offline",
      [
        {
          id: HOST,
          status: "disconnected",
          providers: [
            {
              id: "codex",
              usage: {
                status: "ok" as const,
                windows: [
                  { label: "Weekly limit", usedPercent: 100, resetsAt: null },
                ],
              },
            },
          ],
        },
      ] satisfies UsageMachine[],
    ],
    ["the machine is unknown", machine([]).map((m) => ({ ...m, id: "other" }))],
  ])("fails open when %s", (_case, machines) => {
    expect(
      checkProviderHealth({
        providerId: "codex",
        model: "openai-codex/gpt-5.6-sol",
        hostId: HOST,
        machines,
      }),
    ).toEqual({ ok: true });
  });

  it("fails open when the host is unknown", () => {
    expect(
      checkProviderHealth({
        providerId: "codex",
        model: "gpt-5.6-sol",
        hostId: null,
        machines: machine([
          {
            id: "codex",
            usage: {
              status: "ok",
              windows: [
                { label: "Weekly limit", usedPercent: 100, resetsAt: null },
              ],
            },
          },
        ]),
      }),
    ).toEqual({ ok: true });
  });
});
