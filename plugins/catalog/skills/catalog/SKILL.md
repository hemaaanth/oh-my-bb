---
name: catalog
description: Use Executor's approved versioned skills and remote services in the current BB project.
---

# Executor

Executor keeps approved versioned skills and agent-facing remote Executor
services for BB projects, machines and harnesses. The plugin ID and skill
discovery identities remain `catalog`, `catalog_search` and `catalog_read`.

- Use `catalog_search` to find an applicable approved skill. An empty query
  lists the skills available in the current context.
- Use `catalog_read` with the returned skill id to load its `SKILL.md` or a
  supporting text file before following the workflow.
- Treat source and revision metadata as provenance. Never substitute an
  unapproved upstream revision for the approved one.
- Skills can contain executable instructions. Follow the normal permission and
  repository safety rules when a skill asks you to run code.

## Readiness and owner actions

Opening Executor does not initialize assignments or materialize skill folders.
An unavailable assignment source is an error, not evidence that no assignments
exist. Do not initialize fresh assignments or move ownership to clear that
error. Existing assignments require the explicit source-first handoff.

Executor credentials stay in native Configuration. Optional Agents profile
toolkit scopes follow the saved Preferences choice. Generic RPC input and an
SDK client identity are not proof of owner approval. `executorDecide` cannot
accept; thread tools keep their actual native approval cards.
