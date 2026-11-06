---
name: catalog
description: Use the skills and remote services that Executor connections provide in the current BB project.
---

# Executor

Executor apps ship skills and remote services to BB threads. The plugin ID and
skill tools stay `catalog`, `catalog_search` and `catalog_read`.

- Use `catalog_search` to find a skill or native capability for the task. An
  empty query lists everything available in this thread.
- Use `catalog_read` with a returned ID, such as `hstack/build`, to load its
  `SKILL.md` or a supporting file before you follow it.
- Use `executor_execute` to call the apps in this thread's Executor
  connections. Read `executor_docs` with name `code-mode` first.
- Skills can contain executable instructions. Follow the normal permission and
  repository safety rules when a skill asks you to run code.

## Approvals and errors

Executor decides which calls need approval. A paused call asks the user in
this thread. You cannot approve it. If no answer came, call `executor_resume`
with the execution ID.

A connection that is "not signed in" needs the user. Ask them to sign in from
Executor settings or with `bb catalog executor connect <connection>`. Do not
look for another way to reach the service.
