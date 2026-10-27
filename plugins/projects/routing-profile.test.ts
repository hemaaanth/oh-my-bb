import { describe, expect, it } from "vitest";
import {
  generateRoutingProfile,
  routingEvidenceFingerprint,
  routingProfilePrompt,
  type RoutingProfileEvidence,
} from "./routing-profile.js";

const evidence: RoutingProfileEvidence = {
  name: "Superspot",
  gitRemoteUrl: "https://github.com/goldsky-io/superspot.git",
  packageJson: JSON.stringify({
    name: "superspot",
    description: "Customer analytics",
    dependencies: { react: "latest", vite: "latest" },
  }),
  readme: "# Superspot\nA product for understanding product usage and customers.",
  mappedSources: ["GitHub · goldsky-io/superspot", "Linear · Superspot"],
  taskTitles: ["Improve the event feed"],
};

describe("project routing profiles", () => {
  it("builds qualitative evidence and a stable source fingerprint", () => {
    const prompt = routingProfilePrompt(evidence);
    expect(prompt).toContain("product and domain language");
    expect(prompt).toContain("notFor");
    expect(prompt).toContain("understanding product usage");
    expect(prompt).toContain("Linear · Superspot");
    expect(routingEvidenceFingerprint(evidence)).toBe(routingEvidenceFingerprint({ ...evidence }));
    expect(routingEvidenceFingerprint(evidence)).not.toBe(routingEvidenceFingerprint({ ...evidence, readme: "Changed" }));
  });

  it("requests structured JSON from the cheap Gemini model route", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          description: "Superspot helps teams understand product usage and customers.",
          keywords: ["product analytics", "customers", "customers"],
          aliases: ["Superspot"],
          repositories: ["goldsky-io/superspot"],
          notFor: ["Using Superspot dashboards", "Using Superspot dashboards"],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const profile = await generateRoutingProfile({ apiKey: "secret", model: "google/gemini-2.5-flash-lite", evidence, fetchImpl });
    expect(body).toMatchObject({
      model: "google/gemini-2.5-flash-lite",
      response_format: { type: "json_schema" },
    });
    expect(profile.keywords).toEqual(["product analytics", "customers"]);
    expect(profile.notFor).toEqual(["Using Superspot dashboards"]);
  });
});
