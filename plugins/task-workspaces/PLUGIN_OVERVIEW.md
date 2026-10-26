# Tasks

Sync and manage Akiflow, Linear, and GitHub tasks.

## Plan work

- Put urgent tasks in Now and high-priority work in Later.
- Open project cards for other tasks. Drag to arrange or move work between projects.
- Keep stable provider identifiers, linked references, ownership, and source destinations.
- Attach existing BB chats or explicitly start new work. Chat state updates without Status Sidebar.
- Use native task mentions, agent tools, or `bb worktasks`.

## Configure

Enter keys in native Configuration. In Preferences, enable each app and choose Akiflow projects or Inbox, GitHub repositories, and Linear teams or projects to sync. Map selected sources to BB projects. The inline **More → Setup guide** covers setup, write permissions, printing, and saved state.

Provider changes and agent changes have separate controls. Agent changes start off. Akiflow uses a private web API that can change without notice. Provider selections, credentials, and existing task data remain private to the installation.

Akiflow's client identifier stays in private installation storage. An existing installation must preserve that identity during cutover; new installations generate their own. The package does not ship a shared device identifier.

## Optional integrations

Tasks runs without any suite plugins. Task chats use native BB threads. Status Sidebar owns its own Attach to task opt-in. Tasks uses native BB projects and never installs, enables, or probes another plugin at startup.

An optional receipt printer uses your configured HTTPS endpoint and existing print API key. Printing sends urgent task titles only after you press Print Now. No server is supplied.

## Requirements

BB 0.46.1 or later and Plugin SDK 0.6.49 or later. Each provider needs its own account and credential. Install and build from this package directory. No repository-root runtime dependencies are required.
