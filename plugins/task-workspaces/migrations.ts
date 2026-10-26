export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'triage' CHECK (status IN ('triage','backlog','todo','doing','review','done')),
      project_id TEXT,
      thread_id TEXT,
      environment_id TEXT,
      merge_pending INTEGER NOT NULL DEFAULT 0,
      dismissed_pr_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_refs (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('akiflow','linear','github')),
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS task_refs_task_id ON task_refs(task_id);`,
  `CREATE TABLE IF NOT EXISTS project_mappings (
      source_key TEXT PRIMARY KEY,
      bb_project_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  `CREATE TABLE IF NOT EXISTS github_repositories (
      full_name TEXT PRIMARY KEY COLLATE NOCASE,
      html_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );`,
  `ALTER TABLE tasks ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE tasks ADD COLUMN agent_profile_id TEXT;`,
  `CREATE TABLE IF NOT EXISTS owners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_me INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    ALTER TABLE tasks ADD COLUMN owner_id TEXT;
    ALTER TABLE tasks ADD COLUMN owner_source TEXT NOT NULL DEFAULT 'local' CHECK (owner_source IN ('local','linear'));`,
  `CREATE TABLE IF NOT EXISTS akiflow_identifiers (
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE
    );
    INSERT OR IGNORE INTO akiflow_identifiers (external_id)
      SELECT external_id FROM task_refs WHERE provider = 'akiflow' ORDER BY rowid;`,
  `UPDATE tasks SET owner_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE owner_source = 'local'
        AND owner_id IN (SELECT id FROM owners WHERE is_me = 1)
        AND EXISTS (SELECT 1 FROM task_refs WHERE task_refs.task_id = tasks.id AND provider = 'github')
        AND NOT EXISTS (SELECT 1 FROM task_refs WHERE task_refs.task_id = tasks.id AND provider IN ('linear', 'akiflow'));`,
  `CREATE TABLE IF NOT EXISTS linear_sources (
      source_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('team','project')),
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      detail TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO linear_sources
      (source_key, kind, external_id, name, detail, enabled, updated_at)
    SELECT DISTINCT
      json_extract(metadata, '$.sourceKey'),
      CASE WHEN json_extract(metadata, '$.sourceKey') LIKE 'linear:project:%' THEN 'project' ELSE 'team' END,
      CASE
        WHEN json_extract(metadata, '$.sourceKey') LIKE 'linear:project:%'
          THEN substr(json_extract(metadata, '$.sourceKey'), length('linear:project:') + 1)
        ELSE substr(json_extract(metadata, '$.sourceKey'), length('linear:team:') + 1)
      END,
      COALESCE(json_extract(metadata, '$.projectName'), json_extract(metadata, '$.teamName'),
        json_extract(metadata, '$.teamKey'), json_extract(metadata, '$.sourceKey')),
      CASE WHEN json_extract(metadata, '$.sourceKey') LIKE 'linear:project:%'
        THEN COALESCE(json_extract(metadata, '$.teamName'), json_extract(metadata, '$.teamKey')) ELSE NULL END,
      1,
      CURRENT_TIMESTAMP
    FROM task_refs
    WHERE provider = 'linear'
      AND (json_extract(metadata, '$.sourceKey') LIKE 'linear:project:%'
        OR json_extract(metadata, '$.sourceKey') LIKE 'linear:team:%');`,
  `CREATE TABLE IF NOT EXISTS provider_settings (
      provider TEXT PRIMARY KEY CHECK (provider IN ('akiflow','linear','github')),
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO provider_settings (provider, enabled, updated_at)
      SELECT 'akiflow', EXISTS(SELECT 1 FROM task_refs WHERE provider = 'akiflow'), CURRENT_TIMESTAMP;
    INSERT OR IGNORE INTO provider_settings (provider, enabled, updated_at)
      SELECT 'linear', EXISTS(SELECT 1 FROM task_refs WHERE provider = 'linear'), CURRENT_TIMESTAMP;
    INSERT OR IGNORE INTO provider_settings (provider, enabled, updated_at)
      SELECT 'github', EXISTS(SELECT 1 FROM task_refs WHERE provider = 'github'), CURRENT_TIMESTAMP;`,
  `CREATE TABLE tasks_rebuild (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'triage' CHECK (status IN ('triage','backlog','todo','doing','blocked','review','done','cancelled')),
      project_id TEXT,
      thread_id TEXT,
      environment_id TEXT,
      merge_pending INTEGER NOT NULL DEFAULT 0,
      dismissed_pr_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      agent_profile_id TEXT,
      owner_id TEXT,
      owner_source TEXT NOT NULL DEFAULT 'local' CHECK (owner_source IN ('local','linear'))
    );
    INSERT INTO tasks_rebuild
      (id, title, description, status, project_id, thread_id, environment_id, merge_pending,
       dismissed_pr_url, created_at, updated_at, hidden, sort_order, agent_profile_id, owner_id, owner_source)
    SELECT
      id, title, description, status, project_id, thread_id, environment_id, merge_pending,
      dismissed_pr_url, created_at, updated_at, hidden, sort_order, agent_profile_id, owner_id, owner_source
    FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_rebuild RENAME TO tasks;`,
  `CREATE INDEX IF NOT EXISTS tasks_thread_id ON tasks(thread_id);`,
  `CREATE TABLE IF NOT EXISTS declined_thread_task (
      thread_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      declined_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, task_id)
    );`,
  `ALTER TABLE tasks ADD COLUMN dismissed_archive_thread_id TEXT;`,
  `CREATE TABLE IF NOT EXISTS archive_task_prompts (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
  `CREATE TABLE IF NOT EXISTS task_focus (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      now_rank INTEGER,
      workstream TEXT CHECK (workstream IN ('programming','gtm','other')),
      execution TEXT CHECK (execution IN ('bb','outside'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS task_focus_now_rank ON task_focus(now_rank) WHERE now_rank IS NOT NULL;`,
  `DROP INDEX IF EXISTS task_focus_now_rank;
    ALTER TABLE task_focus DROP COLUMN now_rank;`,
  `DROP TABLE IF EXISTS task_focus;`,
  `UPDATE tasks SET description = '' WHERE description = '[object Object]';
    UPDATE task_refs SET metadata = json_set(metadata, '$.description', '')
      WHERE json_extract(metadata, '$.description') = '[object Object]';`,
  `ALTER TABLE tasks ADD COLUMN list_position INTEGER;`,
  // A task can have many chats and a chat can have many tasks. tasks.thread_id and
  // tasks.environment_id are copied here once and then left unread.
  `CREATE TABLE IF NOT EXISTS task_threads (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      environment_id TEXT,
      started_by_task INTEGER NOT NULL DEFAULT 0,
      attached_at TEXT NOT NULL,
      PRIMARY KEY (task_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS task_threads_thread_id ON task_threads(thread_id);
    INSERT OR IGNORE INTO task_threads (task_id, thread_id, environment_id, started_by_task, attached_at)
      SELECT id, thread_id, environment_id, 1, updated_at FROM tasks WHERE thread_id IS NOT NULL;`,
  // Projects the user hid from All tasks. An empty id is the "No project" card.
  `CREATE TABLE IF NOT EXISTS hidden_projects (
      project_id TEXT PRIMARY KEY,
      hidden_at TEXT NOT NULL
    );`,
  // INSERT OR IGNORE used up an Akiflow number on every read, so ids reached AKI-1500000.
  // Renumber the live ones 1..n in first-seen order and reset the counter.
  `DELETE FROM akiflow_identifiers
      WHERE external_id NOT IN (SELECT external_id FROM task_refs WHERE provider = 'akiflow');
    UPDATE akiflow_identifiers SET number = -number;
    UPDATE akiflow_identifiers SET number = ranked.position
      FROM (SELECT external_id, row_number() OVER (ORDER BY number DESC) AS position FROM akiflow_identifiers) AS ranked
      WHERE akiflow_identifiers.external_id = ranked.external_id;
    UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(number), 0) FROM akiflow_identifiers)
      WHERE name = 'akiflow_identifiers';`,
  `CREATE TABLE IF NOT EXISTS akiflow_sources (
      source_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO akiflow_sources (source_key, name, enabled, updated_at)
      SELECT
        CASE WHEN json_extract(metadata, '$.sourceKey') LIKE 'akiflow:project:%'
          THEN json_extract(metadata, '$.sourceKey') ELSE 'akiflow:inbox' END,
        CASE WHEN json_extract(metadata, '$.sourceKey') LIKE 'akiflow:project:%'
          THEN COALESCE(json_extract(metadata, '$.projectPath'), json_extract(metadata, '$.sourceLabel'),
            json_extract(metadata, '$.sourceKey')) ELSE 'Inbox' END,
        1, CURRENT_TIMESTAMP
      FROM task_refs WHERE provider = 'akiflow';
    INSERT OR IGNORE INTO akiflow_sources (source_key, name, enabled, updated_at)
      SELECT source_key, substr(source_key, length('akiflow:project:') + 1), 1, CURRENT_TIMESTAMP
      FROM project_mappings WHERE source_key LIKE 'akiflow:project:%';
    INSERT OR IGNORE INTO akiflow_sources (source_key, name, enabled, updated_at)
      VALUES ('akiflow:inbox', 'Inbox', 0, CURRENT_TIMESTAMP);`,
] as const;
