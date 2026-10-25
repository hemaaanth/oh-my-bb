---
name: clasi
description: Retain safe durable context, reusable working lessons, and actionable papercuts across bb projects and environments.
---

# Clasi

Clasi provides three kinds of scoped memory:

- Context: a durable fact or explicit preference.
- Napkin: a reusable lesson with a concrete situation and action.
- Papercut: unresolved, fixable friction with a stable fingerprint.

This skill and the active Napkin view activate in every agent session. Environment records override project records with the same logical key; project records override global records. Project scope follows the canonical Git remote, so managed and standalone worktrees share the same Napkins.

## Topics
Every Context entry carries a topic: `engineering` (default), `workflow`, `design`, or `copy`. Napkins may also use the `Design` and `Copy` categories. Engineering and workflow records share the main injection budget exactly as before; design and copy records render in a small fixed reserve, so they can never starve or evict engineering context.

Design and copy records describe product decisions, not code. Never infer acceptance for them: do not write a design or copy Context entry or Napkin unless the user explicitly confirmed the decision in this conversation. Separately installed Pinpoint offers an optional consent loop that records a consent reference; Clasi does not require Pinpoint. Design/copy Context writes without a consent reference are flagged as unconsented in the dashboard for review.

Papercuts are softer: the active view exposes only open severity counts. Read or update details only when the current task needs them.

## Capture rules
Before the final response after non-trivial work, evaluate the completed task once. If it produced a safe durable fact or preference, reusable lesson, or recurring fixable friction, call the matching Clasi tool. If it produced none, retain nothing. This evaluation is required; a write is not.


1. Use Context for facts and preferences that remain true beyond one incident.
2. Use a Napkin when a future agent can take a concrete action to avoid repeated work.
3. Use a Papercut when the workflow or product should be repaired instead of remembered forever.
4. Ignore trivia, one-off outcomes, speculation, duplicates, and rules already enforced by code.
5. Keep fields generalized, actionable, and under 240 characters.

Never store raw prompts, messages, terminal output, source excerpts, paths, secrets, PII, or customer data. If safe classification is uncertain, do not call a mutation tool.

Routine capture is silent. Mention Clasi only when retention is unsafe or a write fails.
