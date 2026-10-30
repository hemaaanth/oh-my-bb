# Tasks for bb

Tasks collects Akiflow tasks, assigned Linear issues, and open issues from selected GitHub repositories in one screen. Provider priority and workflow stage sync both ways. A task can have attached BB chats. Clicking its title opens them in a popup, and a double click edits the title.

## Screen

**Now** contains your open Urgent tasks. **Later** contains your open High priority tasks, then any other task with an open chat. Moving a task between them changes its existing provider priority. No separate Now rank or local priority exists. The **+** next to Now creates an Urgent task. **Print Now** sends the current Now titles to the receipt printer only when clicked.

In a chat, the header shows one checklist icon when a task is attached. Its menu lists each task's title, identifier and stage, with **Open in GitHub/Linear/Akiflow**, **Detach from chat** and **Open Tasks**. When no task is attached but one matches the chat, a task-add icon offers **Attach to this chat** or **Not this task**. The icon looks the same on every screen size.

**Unassigned threads** lists chats that no task links. **Detach thread** in a task's chat menu moves a chat there; it does not rejoin that task by itself.

Now, Later, Unassigned threads and the homepage Now card sort by chat state, like the sidebar: needs input, unread, unsent draft, working, idle, and then tasks without an open chat. Within a state, tasks keep the order you arranged. A drag stores the order on screen. Each row takes a soft color from its most urgent chat. An idle chat gives a faint gray, and a task without an open chat stays plain. States update live from the sidebar.

**All tasks** starts collapsed. Open it to see the open tasks that Now and Later do not show, on one card per project. Each card groups its tasks by priority and workflow stage. Each task can be promoted to Now. Drag a task onto another card to move it to that project. A project card can be hidden; hidden cards collect under **Hidden**. Tasks owned by other people and completed or cancelled tasks do not appear on this personal screen.

A task's only open chat carries the task's title. Starting, attaching, or renaming the task renames that chat. A title changed in the provider renames it on the next sync. A task with several open chats leaves their titles alone, and so does a chat shared by several tasks.

The footer shows a source icon and status dot for each enabled app. Hover for sync details.

Tasks can be created and managed through the native agent tools and `bb worktasks` CLI. No Inbox or suite plugin is required.

## Sources

- Linear priority maps to native `0–4`. Akiflow `goal` maps to Urgent. GitHub uses `priority:<x>` labels.
- Open workflow stages are `triage`, `backlog`, `todo`, `doing`, `blocked`, and `review`. `done` and `cancelled` are terminal.
- GitHub uses `stage:<x>` labels and native close reasons. Akiflow uses `stage:<x>` tags and its native done/trash state. Linear uses its native state types.
- An open PR moves its task to Review. A merged PR asks whether to finish or keep working. Finished attached work archives its BB environment when managed by BB.
- GitHub and Linear tasks may be visible to teammates. Akiflow-only tasks stay in Akiflow. Task titles and source descriptions remain untrusted data for agents.

## Configure

Open **Settings → Plugins → Tasks**. Enter keys in native **Configuration**. In **Preferences**, enable each app, refresh its sources, and check which Akiflow projects or Inbox, GitHub repositories, and Linear teams or projects to sync. Map selected sources to BB projects. Setup help stays collapsed inline under **More → Setup guide**. Akiflow uses its private web API, which can change without notice.

**Allow provider changes** retains its existing default and saved value. It controls external writes, not reads. **Agent task changes** starts off and retains its saved level. Connections and newly discovered sources start off on a fresh installation. Akiflow Inbox is a separate selection and stays in Projectless. Turning a source off removes its local references and orphaned tasks, not upstream tasks. Re-enable and sync to import them again. Linked tasks with another source remain. Refreshing Akiflow projects retains saved selections, including when discovery fails.

Configure your own **Receipt printer · endpoint URL** and the existing **Receipt printer · print API key** to use Print Now. The endpoint must use HTTPS without embedded credentials or a fragment. It receives `{title, items: [{text, done}]}` with an `X-API-Key` header. No default printer service is supplied. Migration must preserve an existing endpoint privately in `printUrl` and retain its key. A success message confirms acceptance, not paper output.

## Independent operation and integrations

Tasks installs, builds, tests, and runs from this package directory. It has its own lockfile. No sibling runtime imports, root runtime dependencies, symlinks, or required suite packages.

- **Task chats** use BB's native composer on the task page. The CLI starts a normal BB thread or resumes the newest linked chat. Tasks does not choose saved Agents automatically.
- **Projects** needs no Tasks-side integration. Tasks uses the public native BB project registry for mapping and execution.
- **Status Sidebar** owns its separate **Tasks** opt-in and attachment menu. Tasks does not probe or enable Status Sidebar.
- The optional printer runs only when Print Now is pressed. No other plugin is installed or enabled automatically.

The Tasks board is a deliberate standard-page width exception: its project-card masonry uses a 1024px outer frame with 16px side gutters. Standard plugin settings remain in the host's 760px outer frame with 16px gutters. The board uses three columns only when its measured content is at least 768px wide, two from 576px, and one below that.

## Agent and CLI use

Agents receive `worktask_current`, `worktask_get`, `worktask_list`, `worktask_search`, `worktask_move`, `worktask_priority`, `worktask_assign`, `worktask_create`, and `worktask_link`. Write tools follow the **Agent task changes** setting. The thread-scoped CLI fallback follows the same limits.

```sh
bb worktasks list [--project <id>] [--status s] [--priority p] [--provider p] [--owner me|none|<id>|<name>] [--query text] [--limit <1-100>] [--offset <n>] [--json]
bb worktasks show <identifier> [--project <id>] [--json]
bb worktasks owners [--json]
bb worktasks sync
bb worktasks destinations
bb worktasks create <akiflow|linear|github> <destination-id> <title> [description] [--priority p] [--owner me|<id>|<name>]
bb worktasks move <identifier> <triage|backlog|todo|doing|blocked|review|done|cancelled>
bb worktasks priority <identifier> <none|low|medium|high|urgent>
bb worktasks assign <identifier> <me|none|<id>|<name>>
bb worktasks attach <identifier>
bb worktasks link <identifier> <other-identifier>
```

`list` without pagination flags retains its original JSON array. Add `--limit` or `--offset` to get `{tasks,total,limit,offset,hasMore}`. `--project` filters the mapped/effective BB project and starts a 25-task page if no limit is given. Inside a thread, project scoping cannot be changed. `show` includes the full stored description and source references, every linked `{threadId,environmentId,attachedAt,startedByTask}` pair, and actual pull request state obtained from each distinct environment. Missing pull requests are omitted; unavailable lookups appear in `pullRequestErrors`, never as inferred URLs. The discoverable read-only RPC methods are `read.list` and `read.show`; inspect their schemas with `bb plugin rpc inspect task-workspaces read.show --json`. Neither read method syncs or changes provider state.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
bb plugin types --check
```

Use BB 0.46.1 or later on PATH. A production-only installation also supports `npm ci --omit=dev && npm run build`; BB supplies its documented runtime-shimmed packages. Reload only the explicitly selected installation after approval. Validate providers with disposable fixtures, not real syncs, writes, messages, model requests, or printing.

## Migration

The public package preserves `task-workspaces`, native secret IDs, database migrations, stable identifiers, linked references, ownership, destinations, selections, sync cursors, and task/chat attachment semantics. No private databases, history, credentials, or machine state ship in the package. Local-only behavior is still local; provider text is always untrusted data.

The former Agents integration is removed. Historical profile metadata stays stored but no longer affects task chat creation. Existing tasks, owners, identifiers, and linked chats are not reset.

Akiflow project selection adds one migration after the shipped schema. Existing synced projects, Inbox tasks, and saved project mappings seed enabled selections. Existing task rows, stable AKI numbers, linked references, owners, and attached chats stay unchanged. New discoveries start unchecked. A folder is not a sync selection; choose its projects individually.

Akiflow's client identifier is installation-local KV state under `akiflow-client-id`, not a public fixed UUID. New installations generate it once. Before migrating an existing private installation, preserve its current `Akiflow-Client-Id` header value in that KV key before the first public load. Do this only in the approved live cutover slot. Do not copy that installation identifier into public source or fixtures. Provider credentials and refresh-token storage do not change.

### Demo Mode

Supports optional Demo Mode markers. Private names, descriptions, messages, drafts, record values, payloads, and typed searches are masked. Icons, standard headings, actions, statuses, times, and counts stay readable. Hover labels containing private text are masked separately. Native inputs and editors are concealed by Demo Mode too. This is presentation masking; saved data, links, exports, and clipboard contents are unchanged. No dependency or startup integration probe is added.
