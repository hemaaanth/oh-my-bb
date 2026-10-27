import { createHash } from "node:crypto";
import { canonicalRecords, type AssignmentRecord } from "./assignment-contract.js";

export function assignmentDigest(records: AssignmentRecord[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalRecords(records))).digest("hex");
}
