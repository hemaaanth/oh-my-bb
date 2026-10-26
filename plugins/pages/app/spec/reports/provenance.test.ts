import { describe, expect, it } from "vitest";
import { readProvenance, type Provenance } from "./provenance.js";
import type { Value } from "./types.js";

function read(stages: Value, expected?: Value): Provenance {
  const result = readProvenance(stages, expected);
  if (!result.ok) throw new Error(result.error);
  return result.provenance;
}

describe("deployment receipts", () => {
  it("does not confirm an identity from a stage without a receipt", () => {
    const chain = read([{ name: "Install", facts: { branch: "release" } }], { branch: "release" });
    expect(chain.lastReceipt).toBe(-1);
    expect(chain.expected[0]?.confirmed).toBe(false);
    expect(chain.stages[0]?.receipt).toBe("none");
    expect(chain.verdict.tone).not.toBe("good");
  });

  it("flags a revision change between successful build and install stages", () => {
    const chain = read([{ name: "Build", status: "done", facts: { sha: "abc123456789" } }, { name: "Install", status: "done", facts: { sha: "def123456789" } }]);
    expect(chain.mismatches).toMatchObject([{ stage: 1, key: "sha", actual: "def123456789", check: { kind: "changed", stage: 0, previous: "abc123456789" } }]);
    expect(chain.verdict.tone).toBe("bad");
  });

  it("accepts a short revision receipt without marking an unreported launch done", () => {
    const chain = read([{ name: "Install", status: "done", facts: { sha: "abc1234" } }, { name: "Launch" }], { sha: "abc123456789" });
    expect(chain.expected[0]?.confirmed).toBe(true);
    expect(chain.mismatches).toEqual([]);
    expect(chain.lastReceipt).toBe(0);
    expect(chain.stages[1]?.status).toBe("unknown");
    expect(chain.stages[1]?.receipt).toBe("none");
  });
});
