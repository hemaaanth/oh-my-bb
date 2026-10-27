import { describe, expect, it } from "vitest";
import {
  generateRoutingLearning,
  hasRoutingEvidence,
  projectRoutingEvidence,
  routingLearningFingerprint,
  routingLearningPrompt,
  type RoutingTrace,
} from "./routing-learning.js";

const names = new Map([["p_bb", "bb"], ["p_plugins", "bb-plugins"]]);
const trace = (threadId: string, createdAt: number, message: string, suggested: string | null, finalProjectId: string | null, outcome: RoutingTrace["outcome"]): RoutingTrace => ({
  threadId, createdAt, message, finalProjectId, outcome,
  suggested: { kind: suggested === null ? "no_project" : "project", projectId: suggested },
});

const traces = [
  trace("t1", 1, "Fix the thread list flicker in core", "p_bb", "p_bb", "hit"),
  trace("t2", 2, "Use bb sub-agents to research CRMs", "p_bb", null, "miss"),
  trace("t3", 3, "Add a panel to pinpoint", "p_bb", "p_plugins", "miss"),
];

describe("routing learning", () => {
  it("collects where requests started and where Jev was wrong", () => {
    const evidence = projectRoutingEvidence("p_bb", traces, names);
    expect(evidence.startedHere).toEqual([{ request: "Fix the thread list flicker in core", jevSuggested: "bb" }]);
    expect(evidence.wronglySuggestedHere).toEqual([
      { request: "Add a panel to pinpoint", userStartedIn: "bb-plugins" },
      { request: "Use bb sub-agents to research CRMs", userStartedIn: "no project" },
    ]);
    expect(projectRoutingEvidence("p_plugins", traces, names).startedHere).toEqual([
      { request: "Add a panel to pinpoint", jevSuggested: "bb" },
    ]);
    expect(hasRoutingEvidence(projectRoutingEvidence("p_other", traces, names))).toBe(false);
  });

  it("changes its fingerprint only when the evidence changes", () => {
    const evidence = projectRoutingEvidence("p_bb", traces, names);
    expect(routingLearningFingerprint(evidence)).toBe(routingLearningFingerprint(projectRoutingEvidence("p_bb", [...traces], names)));
    expect(routingLearningFingerprint(evidence)).not.toBe(routingLearningFingerprint(projectRoutingEvidence("p_bb", traces.slice(1), names)));
  });

  it("asks for generalized guidance and dedupes the answer", async () => {
    const prompt = routingLearningPrompt({ projectName: "bb", description: "BB core.", notFor: ["Plugin work"], evidence: projectRoutingEvidence("p_bb", traces, names) });
    expect(prompt).toContain("wronglySuggestedHere");
    expect(prompt).toContain("Do not copy requests");
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        learnedFor: ["Core thread engine bugs", "core thread engine bugs"],
        learnedNotFor: ["Research that only uses BB agents"],
      }) } }],
    }), { status: 200 });
    await expect(generateRoutingLearning({ apiKey: "secret", model: "m", prompt, fetchImpl })).resolves.toEqual({
      learnedFor: ["Core thread engine bugs"],
      learnedNotFor: ["Research that only uses BB agents"],
    });
  });
});
