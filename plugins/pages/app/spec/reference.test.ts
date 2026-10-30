import { describe, expect, it } from "vitest";
import { specReference } from "./reference.js";
import { checkOpenUi } from "../../server/spec/check.js";

describe("agent reference", () => {
  it("keeps generated actions read-only and avoids fabricated source data", () => {
    const reference = specReference()["openui.md"]!;
    expect(reference).not.toContain("Mutation(");
    expect(reference).not.toContain("realistic mock data");
    expect(reference).toContain("@Run(queryRef)");
    expect(reference).toContain("explain the missing source");
  });

  it("checks the introductory reply example against the actual component catalog", () => {
    const reference = specReference()["openui.md"]!;
    const example = reference.match(/```openui-lang\n([\s\S]*?)```/u)![1]!;
    expect(checkOpenUi(example)).toMatchObject({ ok: true, issues: [] });
  });
});
