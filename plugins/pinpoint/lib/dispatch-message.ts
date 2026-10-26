// The prompt sent to the agent when a Pinpoint annotation is dispatched.
// Pure annotation-in/string-out (extracted from server.ts) so the rendered
// message is unit-testable: enriched context lines only appear when their
// field is populated, intent/severity always render (with read-time
// defaults), and picker-anchored items instruct the agent to persist the
// data-pp attribute in source.
// Page-derived fields (text the RENDERED PAGE controls — nearby text,
// selected text, accessibility, nearby elements, computed styles, React
// component names) are wrapped in the delimited page-content block from
// lib/commands.ts so captured page text can never masquerade as
// instructions. Locator fields that must stay outside the block to be usable
// as locators (selector, full DOM path, classes, url) are neutralized via
// neutralizeLocator (newlines/backticks/delimiter strings stripped). Truly
// trusted context (server-validated ids, the user's own comment,
// intent/severity, instructions) renders as-is.
import { intentOf, severityOf, type AfsAnnotation } from "./afs";
import {
  TOOL_RESOLVE,
  TOOL_SHOW,
  cmdAsk,
  cmdReady,
  cmdReject,
  delimitUntrusted,
  neutralizeLocator,
} from "./commands";

export interface DispatchMessageOptions {
  followUp?: boolean;
  /** Legacy rows may lack `annotation.url`; the row's url column fills in. */
  fallbackUrl?: string;
  /**
   * True when at least one screenshot is stored for this annotation: the
   * prompt then tells the agent it can view the pixels via the
   * `pinpoint_show` tool (the guaranteed delivery path — a dispatch
   * attachment is best-effort only).
   */
  hasScreenshot?: boolean;
}
function visibleTargetLabel(annotation: AfsAnnotation): string {
  const component = annotation.reactComponents
    ?.split(/[>,]/u, 1)[0]
    ?.trim();
  if (component && /^[A-Za-z_$][A-Za-z0-9_$.-]{0,47}$/u.test(component)) {
    return component;
  }
  const element = annotation.element?.toLowerCase();
  return element && /^[a-z][a-z0-9-]*$/u.test(element)
    ? `<${element}>`
    : "Element";
}

export function visibleDispatchMessageFor(annotation: AfsAnnotation): string {
  const comment = annotation.comment.replace(/\s+/gu, " ").trim();
  const fallback = annotation.kind === "text-edit" ? "Text edit" : "Pinpoint feedback";
  return `\`${visibleTargetLabel(annotation)}\` ${comment || fallback}`;
}


export function dispatchMessageFor(
  annotation: AfsAnnotation,
  options: DispatchMessageOptions = {},
): string {
  const lines = [
    `## Pinpoint feedback${options.followUp ? " (follow-up)" : ""}`,
  ];
  if (annotation.comment) lines.push(`> ${annotation.comment}`, "");
  lines.push(
    `- id: \`${annotation.id}\``,
    `- page: ${neutralizeLocator(annotation.url ?? options.fallbackUrl ?? "")}`,
    `- selector: \`${neutralizeLocator(annotation.elementPath)}\``,
    `- intent: ${intentOf(annotation)}`,
    `- severity: ${severityOf(annotation)}`,
  );
  if (annotation.fullPath)
    lines.push(`- full DOM path: \`${neutralizeLocator(annotation.fullPath)}\``);
  if (annotation.sourceFile)
    lines.push(`- source: \`${neutralizeLocator(annotation.sourceFile)}\``);
  if (annotation.cssClasses)
    lines.push(`- classes: ${neutralizeLocator(annotation.cssClasses)}`);
  if (annotation.boundingBox) {
    const b = annotation.boundingBox;
    lines.push(
      `- bounding box: x=${b.x} y=${b.y} width=${b.width} height=${b.height}`,
    );
  }
  if (options.hasScreenshot)
    lines.push(
      `- screenshot: an element crop + surrounding viewport are captured for this pick (the upload may still be in flight). View the pixels with the \`${TOOL_SHOW}\` tool: ${TOOL_SHOW} {"id": "${annotation.id}"} — if none are stored yet it returns the text context only.`,
    );
  if (annotation.pinpoint.anchored)
    lines.push(
      `- durable anchor: the target element carries \`data-pp="${annotation.id}"\` in the live page. Persist this attribute on the same element in the source markup and verify it survives your change, so this feedback pin can re-anchor after the edit.`,
    );
  // Direct text edit (R4): a dedicated instruction section. The old/new text
  // itself is page-controlled content, so it renders INSIDE the delimited
  // block below — only the instruction (trusted, ours) sits outside.
  if (annotation.kind === "text-edit")
    lines.push(
      "",
      "### Text edit",
      "The reviewer edited rendered text directly in the running page. Find the source of this copy and make this change permanent in source — the exact before/after strings are in the page-content block below. The live page already shows the edit, but only as a preview; it is lost on reload until you change the source.",
    );
  // Page-derived capture text goes inside the delimited untrusted block.
  const pageBlock = delimitUntrusted([
    {
      label: "old text",
      value: annotation.textOld != null ? `"${annotation.textOld}"` : null,
    },
    {
      label: "new text",
      value: annotation.textNew != null ? `"${annotation.textNew}"` : null,
    },
    {
      label: "selected text",
      value: annotation.selectedText ? `"${annotation.selectedText}"` : null,
    },
    {
      label: "nearby text",
      value: annotation.nearbyText ? `"${annotation.nearbyText}"` : null,
    },
    { label: "nearby elements", value: annotation.nearbyElements },
    // Free-form React displayName is page-controlled text, not a trusted
    // locator — it belongs inside the block with the other page text.
    { label: "React components", value: annotation.reactComponents },
    { label: "accessibility", value: annotation.accessibility },
    { label: "computed styles", value: annotation.computedStyles },
  ]);
  if (pageBlock) lines.push("", pageBlock);
  if (annotation.thread.length > 0) {
    lines.push("", "### Conversation");
    for (const message of annotation.thread) {
      lines.push(`- ${message.role}: ${message.content}`);
    }
  }
  lines.push(
    "",
    `Address this in the code. When done, mark it ready for my review with the \`${TOOL_RESOLVE}\` tool (outcome "ready" — declare the scope of your change and include the diff as a receipt), or run:\n\n    ${cmdReady(annotation.id)}\n\nIf you need my answer before you can proceed, ask with \`${TOOL_RESOLVE}\` (outcome "question") or \`${cmdAsk(annotation.id)}\`. If you can't act on it, use outcome "reject" or \`${cmdReject(annotation.id)}\`.`,
  );
  return lines.join("\n");
}
