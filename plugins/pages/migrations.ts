// Append-only. Owned by the planner; T1 and T4 add new entries at the end only.
export const PAGE_MIGRATIONS = [
  `CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file','document')),
    project_id TEXT,
    source_key TEXT UNIQUE,
    producer TEXT,
    producer_key TEXT UNIQUE,
    current_version_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX pages_updated ON pages(updated_at DESC) WHERE deleted_at IS NULL;
  CREATE INDEX pages_project_updated ON pages(project_id, updated_at DESC) WHERE deleted_at IS NULL;`,
  `CREATE TABLE page_versions (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    label TEXT,
    html TEXT NOT NULL,
    assets_json TEXT NOT NULL DEFAULT '[]',
    document_json TEXT,
    provenance_json TEXT,
    source_path TEXT,
    sha256 TEXT NOT NULL,
    has_charts INTEGER NOT NULL DEFAULT 0,
    legacy_html TEXT,
    thread_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(page_id, n)
  );
  CREATE INDEX page_versions_page ON page_versions(page_id, n DESC);`,
  `CREATE TABLE page_shares (
    page_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'here-now',
    slug TEXT NOT NULL,
    url TEXT NOT NULL,
    access TEXT NOT NULL CHECK (access IN ('restricted','password','link')),
    allowed_domains_json TEXT NOT NULL DEFAULT '[]',
    allowed_emails_json TEXT NOT NULL DEFAULT '[]',
    password TEXT,
    follow TEXT NOT NULL DEFAULT 'latest',
    live_version_id TEXT,
    remote_version_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('ready','publishing','error')),
    last_error TEXT,
    updated_at TEXT NOT NULL
  );`,
  // One row per imported artifact revision, so the import runs once and is idempotent.
  `CREATE TABLE page_imports (
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    version_id TEXT,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (source, source_id)
  );`,
  // Small key/value markers, e.g. the signature of the legacy store the import last saw.
  `CREATE TABLE page_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
  `ALTER TABLE pages ADD COLUMN folder_path TEXT;`,
] as const;
