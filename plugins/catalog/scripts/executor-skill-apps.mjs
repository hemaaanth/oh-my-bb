#!/usr/bin/env node
// Move Catalog 0.2 Git skill sources into Executor 2 skill apps.
//
// Usage: node scripts/executor-skill-apps.mjs <catalog data.db> <organization id> [apps package version]
//
// It opens the old Catalog database read-only. It prints one Executor execute
// script. Run that script with executor_execute or the org-level /mcp `execute`
// tool. Each source becomes one app named after the source. Executor derives the
// app slug from that name, so skill IDs read `<source>/<skill>`. BB names skill
// folders `catalog-<app name>-<skill>`, so the folders keep their Catalog 0.2
// names. A run creates
// missing apps and redeploys existing ones, so it is safe to run again.
// Skills that were turned off in Catalog stay off: the app filters them by name.
// Executor fails a whole source when one skill breaks its rules, or when the
// source has more than 1,000 files. When that happens, the script redeploys the
// app to load each skill folder that was on in Catalog by itself. A broken skill
// then drops out alone, and the script lists it. Such an app does not pick up
// new upstream skills; edit its `paths` list to add one.
// A private repository needs a GitHub account linked to its app in Executor.
import Database from "better-sqlite3";

const [dbPath, organization, appsVersion = "0.0.1-beta.120"] = process.argv.slice(2);
if (!dbPath || !organization) {
  console.error("Usage: node scripts/executor-skill-apps.mjs <catalog data.db> <organization id> [apps package version]");
  process.exit(2);
}

/** Repositories that need a GitHub token. Public reads need none. */
const PRIVATE = new Set(["hemaaanth/hstack"]);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const sources = db.prepare("SELECT id, name, repository_url AS url, git_ref AS ref, subdirectory AS path FROM catalog_sources WHERE enabled = 1 ORDER BY name").all();
const offRows = db.prepare(`SELECT st.source_id AS sourceId, (SELECT rs.name FROM catalog_release_skills rs WHERE rs.skill_id = st.skill_id LIMIT 1) AS name
  FROM catalog_skill_states st WHERE st.enabled = 0`).all();
const onPaths = db.prepare(`SELECT rs.relative_path AS path FROM catalog_release_skills rs
  WHERE rs.release_id = (SELECT approved_release_id FROM catalog_sources WHERE id = ?)
    AND COALESCE((SELECT enabled FROM catalog_skill_states st WHERE st.source_id = ? AND st.skill_id = rs.skill_id), 1) = 1
  ORDER BY rs.relative_path`);
const onBySource = new Map(sources.map((source) => [source.id, onPaths.all(source.id, source.id).map((row) => row.path)]));
db.close();
const pathsOf = (sourceId) => onBySource.get(sourceId);

const repoOf = (url) => {
  const match = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?\/?$/u.exec(url);
  if (!match) throw new Error(`Not a GitHub repository: ${url}`);
  return match[1];
};
const slugOf = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "")}`;

function appFiles(source, split) {
  const repo = repoOf(source.url);
  const off = offRows.filter((row) => row.sourceId === source.id && row.name).map((row) => row.name).sort();
  const isPrivate = PRIVATE.has(repo);
  const options = [
    `repo: ${JSON.stringify(repo)}`,
    split ? "path" : source.path ? `path: ${JSON.stringify(source.path)}` : null,
    source.ref ? `ref: ${JSON.stringify(source.ref)}` : null,
    ...(isPrivate ? ["account: ctx.app.accounts.github", "token: ctx.app.accounts.github.fields.token"] : []),
    "fetch: ctx.fetch", "signal: ctx.signal", "cache: ctx.cache",
  ].filter(Boolean);
  const load = `githubSkills({ ${options.join(", ")} })`;
  const list = split
    ? `async () => (await Promise.allSettled(paths.map((path) => ${load}))).flatMap((read) => read.status === "fulfilled" ? read.value : [])`
    : off.length === 0 ? `() => ${load}` : `async () => (await ${load}).filter((skill) => !off.has(skill.name))`;
  const index = [
    isPrivate
      ? `import { defineApp, defineProvider, dynamicSkills, object, secrets, string } from "apps";`
      : `import { defineApp, dynamicSkills } from "apps";`,
    `import { githubSkills } from "apps/skills";`,
    "",
    `// Moved from Catalog source "${source.name}".`,
    ...(split
      ? ["// Each skill folder loads by itself, so one broken skill does not hide the others.",
        `const paths = ${JSON.stringify(pathsOf(source.id).map((path) => [source.path, path].filter(Boolean).join("/")), null, 2)};`]
      : off.length ? [`const off = new Set(${JSON.stringify(off)});`] : []),
    ...(isPrivate ? [
      `const github = defineProvider({`,
      `  name: "GitHub",`,
      `  hosts: ["github.com", "raw.githubusercontent.com"],`,
      `  auth: { token: secrets({ label: "Token", fields: object({ token: string() }) }) },`,
      `});`,
    ] : []),
    `export default defineApp(${isPrivate ? "{ app: { accounts: { github } } }" : "{}"}, async (ctx) => ({`,
    `  dynamicSkills: dynamicSkills({ list: ${list} }),`,
    `}));`,
    "",
  ].join("\n");
  return index;
}

const apps = sources.map((source) => {
  const slug = slugOf(source.name);
  const packageJson = { path: "package.json", content: `${JSON.stringify({ name: slug, private: true, type: "module", dependencies: { apps: appsVersion } }, null, 2)}\n` };
  const variant = (split) => [packageJson, { path: "index.ts", content: appFiles(source, split) }];
  return { slug, name: source.name, expected: pathsOf(source.id).length, files: variant(false), splitFiles: variant(true) };
});
process.stdout.write(`// Generated by plugins/catalog/scripts/executor-skill-apps.mjs
const organization = ${JSON.stringify(organization)};
const apps = ${JSON.stringify(apps)};
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
const existing = new Map(plain(await tools.executor.appManagement.list({ path: { organization } })).map((app) => [app.slug, app.id]));
const short = (error) => String(error).replace(/^Error: /u, "").slice(0, 240);
const deploy = async (id, files) => {
  await tools.executor.appManagement.deploy({ path: { organization, app: id }, body: { files } });
  return plain(await tools.executor.skills.list({ path: { organization, app: id } })).skills.map((skill) => skill.name);
};
const results = [];
for (const app of apps) {
  const result = { slug: app.slug, expected: app.expected };
  try {
    let id = existing.get(app.slug);
    if (!id) id = plain(await tools.executor.appManagement.create({ path: { organization }, body: { name: app.name, files: app.files } })).id;
    result.id = id;
    try {
      result.skills = (await deploy(id, app.files)).length;
    } catch (error) {
      // A missing account is not a broken skill. Link the account, then run again.
      if (/AccountRequired/u.test(String(error))) throw error;
      result.whole = short(error);
      result.mode = "per skill";
      result.skills = (await deploy(id, app.splitFiles)).length;
    }
  } catch (error) {
    result.error = short(error);
  }
  results.push(result);
}
return results;
`);
