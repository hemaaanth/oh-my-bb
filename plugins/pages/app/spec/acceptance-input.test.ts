import { describe, expect, it } from "vitest";
import { acceptanceVerdict, readAcceptance } from "./reports/acceptance.js";

describe("Acceptance CSV inputs", () => {
  it("keeps quoted criteria and evidence while leaving untested work unproven", () => {
    const read = readAcceptance('criterion,status,evidence\r\n"Builds, with flags",pass,"First line\nSecond line"\r\nExports CSV,unknown,\r\n');
    if (!read.ok) throw new Error(read.error);
    expect(read.report.criteria.map(row => [row.name, row.own.status])).toEqual([["Builds, with flags", "passed"], ["Exports CSV", "untested"]]);
    expect(read.report.criteria[0]!.own.evidence.map(item => item.kind === "text" ? item.text : null)).toEqual(["First line\nSecond line"]);
    expect(acceptanceVerdict(read.report).tone).not.toBe("good");
  });
  it("retains missing results in a flat device matrix", () => {
    const read = readAcceptance("criterion,Phone,Desktop\nDeep links,pass,fail\nCold start,,pass");
    if (!read.ok) throw new Error(read.error);
    expect(read.report.columns).toEqual(["Phone", "Desktop"]);
    expect(read.report.criteria.map(row => row.cells?.map(cell => cell.status))).toEqual([["passed", "failed"], ["untested", "passed"]]);
  });
  it("reports malformed CSV rather than rendering an empty successful checklist", () => {
    expect(readAcceptance('criterion,status\n"Never closed,pass').ok).toBe(false);
    expect(readAcceptance("criterion,status,status\nBuild,pass,pass").ok).toBe(false);
  });
});
