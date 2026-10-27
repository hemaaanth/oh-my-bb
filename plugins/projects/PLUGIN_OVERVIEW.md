# Projects

Manage native BB projects, groups, 1Password application environments, scripts and services in settings. Projects has no navigation rail page.

## Groups and projects

Groups appear first, with freeform colour pickers and compact name controls. Project rows show repository, group, configured machines and description source. Search or expand the list, then edit a project in a fixed-size dialog. Environment, Suggestions and Skills are separate keyboard-accessible tabs. Preferences autosave. More contains the setup guide.

## Project suggestions

Saved project descriptions help the new-thread composer suggest a project from your prompt. You can write those descriptions yourself. Generate description explicitly asks your selected OpenRouter model to write one from repository metadata and README content. It may cost money and replaces the description and tags. Jev matches later prompts against saved descriptions. Projects does not read Tasks or manage which agents are allowed in a project.

## Skills and shared groups

Projects works without Executor. The optional Skills tab loads Executor skill sets when opened. Saved assignments stay intact if Executor is unavailable. Skill edits send Executor a project-ID refresh hint. Installed Status Sidebar receives group-refresh hints automatically; Sidebar owns its group-source preference. There is no integration switchboard in Projects.

## Application environments

Edit an environment and its masked service-account token together in project settings. Metadata saves check the project and environment revision and never run setup. Existing shared configurations remain clearly marked. Tokens, preparation records and guarded ClickHouse access stay in private installation storage. Remote Executor credentials are separate.

## Scripts and services

Declare commands in each checkout's bb.json or legacy paseo.json. The native Scripts thread action runs them in the selected workspace. Projects retains service tracking, the autostart preference and approved pre-prompt setup. Use bb projects scripts. The separate Scripts plugin is retired.
