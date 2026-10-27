import { describe, expect, it } from "vitest";
import {
  exactProjectMatch,
  interpretProjectChoice,
  packageDescription,
  projectChoiceQuestion,
  projectSummary,
  readmeDescription,
  type ProjectRoutingCandidate,
} from "./project-router";

const projects: ProjectRoutingCandidate[] = [
  { id: "p_bb", name: "bb", repository: "get-bb/bb", summary: "Agentic development environment." },
  { id: "p_site", name: "site", repository: "acme/site", summary: "Marketing website." },
];

describe("project router descriptions", () => {
  it("prefers package metadata and falls back to cleaned README copy", () => {
    expect(packageDescription('{"description":"  A useful app.  "}')).toBe("A useful app.");
    expect(readmeDescription("# Widgets\n\n![build](badge.svg)\nBuild and ship widgets.\n\n## Install\nRun npm install."))
      .toBe("Widgets Build and ship widgets. Install Run npm install.");
    expect(projectSummary({
      name: "widgets",
      repository: "acme/widgets",
      packageJson: '{"description":"Widget service"}',
      readme: "# Ignored",
    })).toBe("Widget service");
  });
});

describe("Jev project routing", () => {
  it("builds one choice criterion per project plus a projectless option", () => {
    const question = projectChoiceQuestion([{ ...projects[0]!, notFor: ["Using BB sub-agents"] }, projects[1]!]);
    expect(question.instructions).toContain("Naming a product, tool, or platform is not enough");
    expect(question.instructions).toContain("notFor");
    expect(question.criteria).toEqual({
      p0: { project: "bb", repositories: ["get-bb/bb"], description: "Agentic development environment.", aliases: [], keywords: [], notFor: ["Using BB sub-agents"], learnedFor: [], recentRequests: [] },
      p1: { project: "site", repositories: ["acme/site"], description: "Marketing website.", aliases: [], keywords: [], notFor: [], learnedFor: [], recentRequests: [] },
      no_project: { description: expect.stringContaining("Work outside any project"), recentRequests: [] },
    });
  });

  it("merges learned guidance and real requests into each option", () => {
    const question = projectChoiceQuestion([{
      ...projects[0]!,
      notFor: ["Using BB sub-agents"],
      learnedNotFor: ["Using BB sub-agents", "Summarizing past threads"],
      learnedFor: ["Thread engine bugs"],
      recentRequests: ["Fix the thread list flicker"],
    }], ["Dinner ideas"]);
    expect(question.criteria.p0).toMatchObject({
      notFor: ["Using BB sub-agents", "Summarizing past threads"],
      learnedFor: ["Thread engine bugs"],
      recentRequests: ["Fix the thread list flicker"],
    });
    expect(question.criteria.no_project).toMatchObject({ recentRequests: ["Dinner ideas"] });
  });

  it("routes exact repository URLs and linked task identifiers without Jev", () => {
    expect(exactProjectMatch("Please fix https://github.com/get-bb/bb/issues/123", projects)?.id).toBe("p_bb");
    expect(exactProjectMatch("Handle AKI-4021 today", projects, [{ projectId: "p_site", values: ["AKI-4021"] }])?.id).toBe("p_site");
    expect(exactProjectMatch("Improve the website", projects)).toBeNull();
  });

  it("leaves project names and aliases to Jev", () => {
    const aliased = [{ ...projects[0]!, name: "blacksmith", aliases: ["agent IDE"] }];
    expect(exactProjectMatch("Use blacksmith sub-agents to research this", aliased)).toBeNull();
    expect(exactProjectMatch("Ask the agent IDE for a summary", aliased)).toBeNull();
  });

  it("auto-applies only a confident project choice", () => {
    expect(interpretProjectChoice(projects, {
      type: "choice",
      choice: "p0",
      probabilities: { p0: 0.82, p1: 0.1, no_project: 0.08 },
      confidence: 0.76,
    })).toMatchObject({
      suggestion: { id: "p_bb", probability: 0.82 },
      autoApply: true,
    });
    expect(interpretProjectChoice(projects, {
      type: "choice",
      choice: "no_project",
      probabilities: { p0: 0.2, p1: 0.15, no_project: 0.65 },
      confidence: 0.7,
    }).suggestion).toBeNull();
  });

  it("suggests no project only when Jev confidently chooses it", () => {
    expect(interpretProjectChoice(projects, {
      type: "choice",
      choice: "no_project",
      probabilities: { p0: 0.2, p1: 0.15, no_project: 0.65 },
      confidence: 0.7,
    })).toMatchObject({ suggestion: null, noProject: { probability: 0.65 }, autoApply: false });
    expect(interpretProjectChoice(projects, {
      type: "choice",
      choice: "no_project",
      probabilities: { p0: 0.3, p1: 0.3, no_project: 0.4 },
      confidence: 0.7,
    }).noProject).toBeNull();
    expect(interpretProjectChoice(projects, {
      type: "choice",
      choice: "p0",
      probabilities: { p0: 0.82, p1: 0.1, no_project: 0.08 },
      confidence: 0.76,
    }).noProject).toBeNull();
  });
});
