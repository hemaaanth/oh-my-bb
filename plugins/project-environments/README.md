# Projects environment compatibility

The old `project-environments` ID forwards its fixed RPCs to Projects. It owns no editor, database writes, token writes, preparation jobs, tools. Keep it installed while old integrations use that ID. The old `bb project-env` command is a forwarding transport; its implementation runs in Projects. Projects owns the original environment IDs and application configuration. No startup preparation runs.
