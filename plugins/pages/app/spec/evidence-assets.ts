import { readAcceptance, readEvidence } from "./reports/acceptance.js";
import { readCompare } from "./reports/compare.js";
import { readProvenance } from "./reports/provenance.js";
import type { Value } from "./reports/types.js";
import { readFindings } from "./reports/findings.js";

/** Only declared media is embedded. Notes and arbitrary report strings are not file reads. */
export function evidenceAssets(name: string, props: Record<string, unknown>): string[] {
  if (name === "OptionCards" && Array.isArray(props.options)) return props.options.flatMap(option => {
    const image = option && typeof option === "object" ? (option as Record<string, unknown>).image : null;
    return typeof image === "string" && image.trim() ? [image.trim()] : [];
  });
  if (name === "Transcript") return typeof props.audio === "string" ? [props.audio] : [];
  if (name === "Compare" && !Array.isArray(props.rows)) {
    const read = readCompare(props.options as Value);
    return read.ok ? read.images.map(image => image.src) : [];
  }
  if (name === "Findings") {
    const read = readFindings(props.findings as Value);
    const review = read.ok ? read.report.review : null;
    return review ? readEvidence([...review.evidence, ...review.artifacts]).flatMap(item => item.kind === "image" ? [item.src] : []) : [];
  }
  if (name === "Acceptance") {
    const read = readAcceptance(props.criteria as Value, props.columns as Value);
    return read.ok ? read.report.criteria.flatMap(criterion => [criterion.own, ...criterion.cells ?? []].flatMap(check => check.evidence.flatMap(item => item.kind === "image" ? [item.src] : []))) : [];
  }
  if (name === "Provenance" && Array.isArray(props.claim)) {
    const read = readProvenance(props.claim as Value, props.steps as Value);
    return read.ok ? read.provenance.stages.flatMap(stage => stage.evidence.flatMap(item => item.kind === "image" ? [item.src] : [])) : [];
  }
  return [];
}
