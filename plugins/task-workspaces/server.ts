import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { MIGRATIONS } from "./migrations";
import { byPosition, isOpenPersonalTask, printTimestamp } from "./task-layout";
import { createProviderTransport, HttpResponseError } from "./provider-transport";
import { registerTaskAgentIntegration, type AgentWriteLevel } from "./agent-tools";
import {
  buildTaskAgentContext,
  attachedTaskStage,
  exactTaskMatch,
  suggestTaskByTitle,
} from "./task-context";

// The composer request is produced by the host and passed straight through to spawn/sandboxes,
// so validate only that it is an object rather than re-deriving the whole shape.
const newThreadRequestSchema = z.custom<NewThreadRequest>(
  (value) => typeof value === "object" && value !== null,
  { message: "Expected a NewThreadRequest from the composer" },
);

const statuses = ["triage", "backlog", "todo", "doing", "blocked", "review", "done", "cancelled"] as const;
const providers = ["akiflow", "linear", "github"] as const;
// Normalized priority: none (null) / low / medium / high / urgent, mapped 1:1 to each
// provider's native tier. Akiflow has no "urgent" tier but its "goal" flag (-1) is its
// highest emphasis, so goal is treated as the urgent equivalent.
const akiflowPriorities = { "-1": "urgent", "1": "high", "2": "medium", "3": "low" } as const;
const linearPriorities = { "1": "urgent", "2": "high", "3": "medium", "4": "low" } as const;
const akiflowPriorityValues = { urgent: -1, high: 1, medium: 2, low: 3, none: 0 } as const;
const linearPriorityValues = { urgent: 1, high: 2, medium: 3, low: 4, none: 0 } as const;
const linearStateTypeByStatus = {
  triage: "triage",
  backlog: "backlog",
  todo: "unstarted",
  doing: "started",
  blocked: "started",
  review: "started",
  done: "completed",
  cancelled: "canceled",
} as const;
const statusSchema = z.enum(statuses);
const providerSchema = z.enum(providers);

const refSchema = z.object({
  provider: providerSchema,
  externalId: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string(),
  url: z.string().nullable(),
  relatedUrls: z.array(z.string()),
  issueKey: z.string().nullable(),
  repository: z.string().nullable(),
  sourceProject: z.string().nullable(),
  sourceTeam: z.string().nullable(),
  priority: z.enum(["urgent", "high", "medium", "low"]).nullable(),
  recurring: z.boolean(),
  projectPath: z.string().nullable(),
  tags: z.array(z.string()),
});

const taskSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  identifiers: z.array(z.string()),
  title: z.string(),
  description: z.string(),
  status: statusSchema,
  projectId: z.string().nullable(),
  effectiveProjectId: z.string().nullable().optional(),
  // threadId and environmentId name the newest chat. threadIds lists every chat, newest first.
  threadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  threadIds: z.array(z.string()),
  owner: z.object({
    id: z.string(),
    name: z.string(),
    isMe: z.boolean(),
    active: z.boolean(),
  }).nullable(),
  mergePending: z.boolean(),
  position: z.number().int().nullable(),
  refs: z.array(refSchema),
});

const attachmentCandidateSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  status: statusSchema,
  attachedThreadId: z.string().nullable(),
  attachedToCurrentThread: z.boolean(),
});
const projectMappingsSchema = z.object({
  projects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["standard", "personal"]),
  })),
  sources: z.array(z.object({
    key: z.string(),
    label: z.string(),
    provider: providerSchema,
    bbProjectId: z.string().nullable(),
    automatic: z.boolean(),
  })),
});

const githubRepositoriesSchema = z.object({
  configured: z.boolean(),
  repositories: z.array(z.object({
    fullName: z.string(),
    url: z.string(),
    enabled: z.boolean(),
  })),
});

const providerSettingsSchema = z.object({
  providers: z.array(z.object({
    provider: providerSchema,
    enabled: z.boolean(),
    configured: z.boolean(),
  })),
});

const linearSourcesSchema = z.object({
  configured: z.boolean(),
  sources: z.array(z.object({
    key: z.string(),
    kind: z.enum(["team", "project"]),
    name: z.string(),
    detail: z.string().nullable(),
    enabled: z.boolean(),
  })),
});

const akiflowSourcesSchema = z.object({
  configured: z.boolean(),
  sources: z.array(z.object({
    key: z.string(),
    name: z.string(),
    enabled: z.boolean(),
  })),
});

const createTaskDestinationSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  /** The bb project a task created here lands in. Null when the source is not mapped. */
  projectId: z.string().nullable(),
});
const createTaskOptionsSchema = z.object({
  providers: z.array(z.object({
    provider: providerSchema,
    destinations: z.array(createTaskDestinationSchema),
    error: z.string().nullable(),
  })),
});
// The Tasks screen draws only my open tasks, so it reads this short form of each one.
const boardTaskSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  status: statusSchema,
  projectId: z.string().nullable(),
  effectiveProjectId: z.string().nullable(),
  threadIds: z.array(z.string()),
  owner: z.object({ isMe: z.boolean() }).nullable(),
  position: z.number().int().nullable(),
  refs: z.array(refSchema.pick({ provider: true, priority: true, url: true })),
});
const createTaskPrioritySchema = z.enum(["urgent", "high", "medium", "low"]);
const createTaskInputSchema = z.object({
  provider: providerSchema,
  destinationId: z.string().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000),
  priority: createTaskPrioritySchema.nullable(),
  ownerId: z.string().min(1).nullable(),
}).strict();

export const rpcContract = defineRpcContract({
  listTasks: {
    input: z.null(),
    output: z.object({
      tasks: z.array(taskSchema),
      owners: z.array(z.object({ id: z.string(), name: z.string(), isMe: z.boolean(), active: z.boolean() })),
      akiflowConnected: z.boolean(),
      enabledProviders: z.array(providerSchema),
    }),
  },
  // linkedThreadIds holds every chat that any task links, open or not.
  boardTasks: {
    input: z.null(),
    output: z.object({ tasks: z.array(boardTaskSchema), hiddenProjectIds: z.array(z.string()), linkedThreadIds: z.array(z.string()) }),
  },
  // Hides a project card from All tasks. An empty id is the "No project" card.
  setProjectHidden: {
    input: z.object({ projectId: z.string(), hidden: z.boolean() }).strict(),
    output: z.object({ hiddenProjectIds: z.array(z.string()) }),
  },
  printNow: {
    input: z.null(),
    output: z.object({ accepted: z.number().int() }),
  },
  setStatus: {
    input: z.object({ taskId: z.string(), status: statusSchema }).strict(),
    output: taskSchema,
  },
  setPriority: {
    input: z.object({ taskId: z.string(), priority: z.enum(["urgent", "high", "medium", "low"]).nullable() }).strict(),
    output: taskSchema,
  },
  renameTask: {
    input: z.object({ taskId: z.string(), title: z.string().trim().min(1).max(500) }).strict(),
    output: taskSchema,
  },
  // Resumes the task's newest chat, or starts one. fresh always starts a new chat.
  attachChat: {
    input: z.object({ taskId: z.string(), fresh: z.boolean().optional() }).strict(),
    output: taskSchema,
  },
  listAttachmentCandidates: {
    input: z.object({ threadId: z.string().min(1), query: z.string().max(500) }).strict(),
    output: z.object({ tasks: z.array(attachmentCandidateSchema) }).strict(),
  },
  attachExistingChat: {
    input: z.object({ taskId: z.string(), threadId: z.string().min(1) }).strict(),
    output: taskSchema,
  },
  threadTask: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      projectId: z.string().min(1),
      attached: taskSchema.nullable(),
      attachedTasks: z.array(taskSchema),
      suggested: taskSchema.nullable(),
    }),
  },
  // Stop suggesting this task for this chat.
  declineThreadTask: {
    input: z.object({ threadId: z.string().min(1), taskId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  // Without taskId, every task leaves the chat.
  detachTaskThread: {
    input: z.object({ threadId: z.string().min(1), taskId: z.string().optional() }).strict(),
    output: taskSchema,
  },
  // Start a chat for a task from a composer request, then attach the thread to the task.
  // The composer's own environment decides where it runs, this machine or a cloud sandbox.
  startTaskThread: {
    input: z.object({ taskId: z.string(), request: newThreadRequestSchema }).strict(),
    output: z.object({ threadId: z.string(), task: taskSchema }),
  },
  answerArchived: {
    input: z.object({ taskId: z.string(), decision: z.enum(["done", "cancelled", "blocked", "keep"]) }).strict(),
    output: taskSchema,
  },
  archivePrompt: {
    input: z.null(),
    output: taskSchema.nullable(),
  },
  projectMappings: {
    input: z.null(),
    output: projectMappingsSchema,
  },
  setProjectMapping: {
    input: z.object({ sourceKey: z.string().min(1), projectId: z.string().min(1).nullable() }).strict(),
    output: projectMappingsSchema,
  },
  githubRepositories: {
    input: z.null(),
    output: githubRepositoriesSchema,
  },
  refreshGithubRepositories: {
    input: z.null(),
    output: githubRepositoriesSchema,
  },
  setGithubRepositoryEnabled: {
    input: z.object({ fullName: z.string().min(1), enabled: z.boolean() }).strict(),
    output: githubRepositoriesSchema,
  },
  linearSources: {
    input: z.null(),
    output: linearSourcesSchema,
  },
  refreshLinearSources: {
    input: z.null(),
    output: linearSourcesSchema,
  },
  setLinearSourceEnabled: {
    input: z.object({ key: z.string().min(1), enabled: z.boolean() }).strict(),
    output: linearSourcesSchema,
  },
  setAllLinearSourcesEnabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: linearSourcesSchema,
  },
  akiflowSources: {
    input: z.null(),
    output: akiflowSourcesSchema,
  },
  refreshAkiflowSources: {
    input: z.null(),
    output: akiflowSourcesSchema,
  },
  setAkiflowSourceEnabled: {
    input: z.object({ key: z.string().min(1), enabled: z.boolean() }).strict(),
    output: akiflowSourcesSchema,
  },
  setAllAkiflowSourcesEnabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: akiflowSourcesSchema,
  },
  providerSettings: {
    input: z.null(),
    output: providerSettingsSchema,
  },
  setProviderEnabled: {
    input: z.object({ provider: providerSchema, enabled: z.boolean() }).strict(),
    output: providerSettingsSchema,
  },
  providerHealth: {
    input: z.null(),
    output: z.array(z.object({
      provider: providerSchema,
      enabled: z.boolean(),
      configured: z.boolean(),
      status: z.enum(["ok", "disabled", "unconfigured", "stale", "error"]),
      lastError: z.string().nullable(),
      lastErrorAt: z.string().nullable(),
      lastOkAt: z.string().nullable(),
    })),
  },
  createTaskOptions: {
    input: z.null(),
    output: createTaskOptionsSchema,
  },
  createTask: {
    input: createTaskInputSchema,
    output: taskSchema,
  },
  // With threadId, the new task is linked to that chat. With priority, it starts in Now or Later.
  createProjectTask: {
    input: z.object({
      projectId: z.string().min(1),
      destinationId: z.string().min(1).max(500),
      title: z.string().trim().min(1).max(500),
      threadId: z.string().min(1).optional(),
      priority: z.enum(["urgent", "high"]).optional(),
    }).strict(),
    output: boardTaskSchema,
  },
  setProject: {
    input: z.object({ taskId: z.string(), projectId: z.string() }).strict(),
    output: taskSchema,
  },
  arrangeTasks: {
    input: z.object({ priority: z.enum(["urgent", "high"]), taskIds: z.array(z.string()).max(500) }).strict(),
    output: z.object({ arranged: z.number().int() }),
  },
});

const taskThreadSchema = z.object({
  threadId: z.string(), environmentId: z.string().nullable(),
  attachedAt: z.string(), startedByTask: z.boolean(),
});
const backedPullRequestSchema = z.object({
  environmentId: z.string(), url: z.string(), number: z.number().int(),
  title: z.string(), state: z.enum(["open", "draft", "closed", "merged"]),
  updatedAt: z.string(), headRefName: z.string(), baseRefName: z.string(),
  checkState: z.enum(["failing", "no_checks", "passing", "pending", "unknown"]),
  reviewState: z.enum(["approved", "changes_requested", "none", "review_requested", "review_required"]),
  mergeability: z.enum(["blocked", "conflicts", "draft", "mergeable", "unknown"]),
});
export const readContract = defineRpcContract({
  "read.list": {
    experimental_description: "Page synced tasks with optional project, stage, priority, provider, owner and text filters. No sync or writes.",
    input: z.object({
      projectId: z.string().nullable().default(null), status: statusSchema.nullable().default(null),
      priority: z.enum(["none", "low", "medium", "high", "urgent"]).nullable().default(null),
      provider: providerSchema.nullable().default(null), owner: z.string().nullable().default(null),
      query: z.string().max(500).default(""), limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).default(0),
    }).strict(),
    output: z.object({
      tasks: z.array(taskSchema), total: z.number().int().nonnegative(),
      limit: z.number().int(), offset: z.number().int(), hasMore: z.boolean(),
    }),
  },
  "read.show": {
    experimental_description: "Read full source refs, every attached thread/environment pair and backed PR state for one task.",
    input: z.object({ identifier: z.string().min(1), projectId: z.string().nullable().default(null) }).strict(),
    output: taskSchema.extend({
      threads: z.array(taskThreadSchema), pullRequests: z.array(backedPullRequestSchema),
      pullRequestErrors: z.array(z.object({ environmentId: z.string(), message: z.string() })),
    }),
  },
});

type Status = typeof statuses[number];
type Provider = typeof providers[number];
type Priority = "urgent" | "high" | "medium" | "low";
// Finer stages (and priority) are represented in tools without workflow columns via
// labels/tags. GitHub gets `stage:<x>` / `priority:<x>` labels; Akiflow gets `stage:<x>`
// tags. done/cancelled always use each tool's native mechanism (close-reason, done flag,
// trash) rather than a label.
const LINEAR_TASK_FIELDS = `fragment TaskFields on Issue {
  id identifier title description url priority updatedAt
  state { id type name }
  assignee { id }
  project { id name }
  team { id key name }
  attachments(first: 50) { nodes { url title } }
}`;
const STAGE_LABEL_PREFIX = "stage:";
const PRIORITY_LABEL_PREFIX = "priority:";
const priorityNames: readonly Priority[] = ["urgent", "high", "medium", "low"];
const priorityRank: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

// A task's effective priority is the strongest across its linked sources.
function taskPriority(task: { refs: Array<{ priority: Priority | null }> }): Priority | null {
  const found = task.refs.map((ref) => ref.priority).filter((value): value is Priority => value !== null);
  return found.sort((left, right) => priorityRank[left] - priorityRank[right])[0] ?? null;
}

// Minimal `--flag value` / `--flag=value` / `--flag` parser for CLI subcommands, returning
// the leftover positional arguments too.
function parseCliFlags(argv: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const equals = token.indexOf("=");
    if (equals >= 0) { flags[token.slice(2, equals)] = token.slice(equals + 1); continue; }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[token.slice(2)] = next; index += 1; }
    else flags[token.slice(2)] = "true";
  }
  return { flags, positional };
}
function statusFromLinearType(value: unknown): Status | undefined {
  if (value === "triage") return "triage";
  if (value === "backlog") return "backlog";
  if (value === "unstarted") return "todo";
  if (value === "started") return "doing";
  if (value === "completed") return "done";
  if (value === "canceled") return "cancelled";
  return undefined;
}
type DbTask = {
  id: string;
  title: string;
  description: string;
  status: Status;
  project_id: string | null;
  owner_id: string | null;
  owner_source: "local" | "linear";
  merge_pending: number;
  dismissed_pr_url: string | null;
  dismissed_archive_thread_id: string | null;
  sort_order: number;
  list_position: number | null;
};
type TaskThread = {
  task_id: string;
  thread_id: string;
  environment_id: string | null;
  started_by_task: number;
  attached_at: string;
};
type DbRef = {
  task_id: string;
  provider: Provider;
  external_id: string;
  title: string;
  url: string | null;
  metadata: string;
};
type ExternalTask = {
  provider: Provider;
  externalId: string;
  title: string;
  description: string;
  url: string | null;
  nativeLinks: string[];
  relatedUrls: string[];
  updatedAt?: string | null;
  status?: Status;
  ownerId?: string | null;
  metadata: Record<string, unknown>;
};
type JsonObject = Record<string, unknown>;
type ProjectInfo = {
  id: string;
  kind: "standard" | "personal";
  name: string;
  gitRemoteUrl: string | null;
};
type SourceScope = {
  key: string;
  label: string;
  provider: Provider;
  ownerRepo?: string;
};
type DbGithubRepository = {
  full_name: string;
  html_url: string;
  enabled: number;
};
type DbLinearSource = {
  source_key: string;
  kind: "team" | "project";
  external_id: string;
  name: string;
  detail: string | null;
  enabled: number;
};
type DbAkiflowSource = {
  source_key: string;
  name: string;
  enabled: number;
};
type DbOwner = {
  id: string;
  name: string;
  is_me: number;
  active: number;
};

// Private API contract adapted from https://github.com/hemaaanth/skills/tree/main/akiflow (MIT).
const AKIFLOW_TASKS = "https://api.akiflow.com/v5/tasks";
const AKIFLOW_LABELS = "https://api.akiflow.com/v5/labels";
const AKIFLOW_TAGS = "https://api.akiflow.com/v5/tags";
const AKIFLOW_REFRESH = "https://web.akiflow.com/oauth/refreshToken";
const LINEAR_API = "https://api.linear.app/graphql";
const GITHUB_REQUEST_CONCURRENCY = 4;
const GITHUB_RETRY_ATTEMPTS = 3;

function now() {
  return new Date().toISOString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}


function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function normalizeUrl(value: string) {
  return value.trim().replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
}

function githubRepoFromRemote(value: string | null) {
  if (!value) return null;
  const match = value.match(/github\.com[/:]([^/#]+\/[^/#]+?)(?:\.git)?(?:[#?].*)?$/i);
  return match?.[1]?.replace(/\.git$/i, "").toLowerCase() ?? null;
}

function jsonRecord(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}


export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    githubToken: { type: "string", label: "GitHub · Personal access token", secret: true },
    linearToken: { type: "string", label: "Linear · API key", secret: true },
    akiflowRefreshToken: {
      type: "string",
      label: "Akiflow · refresh token",
      description: "The refresh_token stored by web.akiflow.com.",
      secret: true,
    },
    printApiKey: {
      type: "string",
      label: "Receipt printer · print API key",
      description: "Print-only key for your receipt printer. Printing runs only when you press Print Now.",
      secret: true,
    },
    printUrl: {
      type: "string",
      label: "Receipt printer · endpoint URL",
      description: "Your HTTPS list-print endpoint. Receives task titles with the print API key.",
      default: "",
    },
    allowWrites: {
      type: "boolean",
      label: "Allow provider changes",
      description: "Turn this off to keep syncing and reading tasks while refusing every change to Linear, GitHub, and Akiflow.",
      default: true,
    },
    agentWrites: {
      type: "select",
      label: "Agent task changes",
      description: "Off gives agents read tools only. Workflow adds stage, priority, and owner changes. Full also allows task creation and linking.",
      options: ["off", "workflow", "full"],
      default: "off",
    },
  });
  let settingsSnapshot = await settings.get();
  let agentWrites = settingsSnapshot.agentWrites;
  settings.onChange((next) => {
    settingsSnapshot = next;
    agentWrites = next.agentWrites;
    bb.realtime.publish("tasks-changed", { reason: "settings" });
  });

  const providerTransport = createProviderTransport({
    allowWrites: () => settingsSnapshot.allowWrites,
    secrets: () => [settingsSnapshot.githubToken, settingsSnapshot.linearToken, settingsSnapshot.akiflowRefreshToken]
      .filter((value): value is string => typeof value === "string"),
  });
  const printTransport = createProviderTransport({
    allowWrites: () => true,
    secrets: () => settingsSnapshot.printApiKey ? [settingsSnapshot.printApiKey] : [],
    timeoutMs: 15_000,
  });

  const savedAkiflowClientId = await bb.storage.kv.get<string>("akiflow-client-id");
  const akiflowClientId = savedAkiflowClientId ?? randomUUID();
  if (!savedAkiflowClientId) await bb.storage.kv.set("akiflow-client-id", akiflowClientId);

  async function fetchJson(url: string, init: RequestInit, provider: string, mutation = false) {
    return providerTransport.json(url, init, { provider, mutation });
  }

  async function fetchGithubJson(url: string, init: RequestInit) {
    const mutation = Boolean(init.method && init.method !== "GET");
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchJson(url, init, "GitHub", mutation);
      } catch (error) {
        const rateLimited = error instanceof HttpResponseError
          && (error.status === 429 || (error.status === 403 && /rate limit/i.test(error.message)));
        if (!rateLimited || mutation || attempt + 1 >= GITHUB_RETRY_ATTEMPTS) throw error;
        const delayMs = error.retryAfterMs ?? 1_000 * 2 ** attempt;
        await wait(Math.min(delayMs, 60_000));
      }
    }
  }

  const db = bb.storage.database();
  // The existing final migration rebuilds the tasks table. It is frozen for
  // installed databases; every future migration must append an additive change.
  db.pragma("foreign_keys = OFF");
  bb.storage.migrate(db, [...MIGRATIONS]);
  db.pragma("foreign_keys = ON");

  function getDbTask(taskId: string) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as DbTask | undefined;
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  function refsFor(taskId: string) {
    return db.prepare("SELECT * FROM task_refs WHERE task_id = ? ORDER BY provider, external_id")
      .all(taskId) as DbRef[];
  }

  // A task's chats, newest first.
  function taskThreads(taskId: string) {
    return db.prepare("SELECT * FROM task_threads WHERE task_id = ? ORDER BY attached_at DESC, rowid DESC")
      .all(taskId) as TaskThread[];
  }

  // A chat's tasks, in the order they joined it.
  function threadTasks(threadId: string) {
    return db.prepare(`SELECT tasks.* FROM task_threads JOIN tasks ON tasks.id = task_threads.task_id
      WHERE task_threads.thread_id = ? ORDER BY task_threads.attached_at, task_threads.rowid`).all(threadId) as DbTask[];
  }

  function threadHasTask(threadId: string) {
    return Boolean(db.prepare("SELECT 1 FROM task_threads WHERE thread_id = ?").get(threadId));
  }

  function enabledProviderSet() {
    return new Set((db.prepare("SELECT provider FROM provider_settings WHERE enabled = 1").all() as Array<{ provider: Provider }>)
      .map(({ provider }) => provider));
  }

  async function providerSettingsState() {
    const current = await settings.get();
    const enabled = enabledProviderSet();
    return {
      providers: providers.map((provider) => ({
        provider,
        enabled: enabled.has(provider),
        configured: provider === "github" ? Boolean(current.githubToken)
          : provider === "linear" ? Boolean(current.linearToken)
            : Boolean(current.akiflowRefreshToken),
      })),
    };
  }

  function removeProviderReferences(provider: Provider) {
    return db.transaction(() => {
      const refs = db.prepare("DELETE FROM task_refs WHERE provider = ?").run(provider).changes;
      const orphaned = db.prepare(`SELECT id FROM tasks WHERE NOT EXISTS
        (SELECT 1 FROM task_refs WHERE task_refs.task_id = tasks.id)`).all() as Array<{ id: string }>;
      const removeTask = db.prepare("DELETE FROM tasks WHERE id = ?");
      for (const task of orphaned) removeTask.run(task.id);
      return { refs, tasks: orphaned.length };
    })();
  }

  function pruneDisabledProviderReferences(enabled = enabledProviderSet()) {
    for (const provider of providers) if (!enabled.has(provider)) removeProviderReferences(provider);
  }
  async function syncGeneration(provider: "github" | "linear") {
    const stored = await bb.storage.kv.get<unknown>(`sync-generation:${provider}`);
    return typeof stored === "number" && Number.isSafeInteger(stored) ? stored : 0;
  }

  async function invalidateSyncCursor(provider: "github" | "linear") {
    await bb.storage.kv.set(`sync-generation:${provider}`, await syncGeneration(provider) + 1);
    await bb.storage.kv.delete(`sync-cursor:${provider}`);
  }


  async function setProviderEnabled(provider: Provider, enabled: boolean) {
    db.prepare(`INSERT INTO provider_settings (provider, enabled, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(provider, enabled ? 1 : 0, now());
    if (!enabled) removeProviderReferences(provider);
    if (provider === "github" || provider === "linear") await invalidateSyncCursor(provider);
    bb.realtime.publish("tasks-changed", { reason: "provider-setting", provider, enabled });
    return providerSettingsState();
  }

  pruneDisabledProviderReferences();

  function ownerDto(owner: DbOwner) {
    return { id: owner.id, name: owner.name, isMe: Boolean(owner.is_me), active: Boolean(owner.active) };
  }

  function currentOwnerId() {
    return (db.prepare("SELECT id FROM owners WHERE is_me = 1 AND active = 1 LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
  }

  function githubAssignee(metadata: JsonObject) {
    const assignee = jsonRecord(metadata.assignee);
    if (typeof assignee.id !== "string" || typeof assignee.name !== "string") return null;
    return { id: assignee.id, name: assignee.name, isMe: assignee.isMe === true, active: true };
  }

  function owners() {
    const available = new Map((db.prepare(`SELECT * FROM owners WHERE active = 1 OR id IN
      (SELECT owner_id FROM tasks WHERE owner_id IS NOT NULL)
      ORDER BY is_me DESC, name COLLATE NOCASE`).all() as DbOwner[]).map((owner) => {
      const dto = ownerDto(owner);
      return [dto.id, dto] as const;
    }));
    for (const ref of db.prepare("SELECT metadata FROM task_refs WHERE provider = 'github'").all() as Array<{ metadata: string }>) {
      const assignee = githubAssignee(jsonRecord(JSON.parse(ref.metadata)));
      if (assignee) available.set(assignee.id, assignee);
    }
    return [...available.values()].sort((left, right) => Number(right.isMe) - Number(left.isMe) || left.name.localeCompare(right.name));
  }

  function akiflowIdentifier(externalId: string, allocate = false) {
    const select = db.prepare("SELECT number FROM akiflow_identifiers WHERE external_id = ?");
    let row = select.get(externalId) as { number: number } | undefined;
    if (!row && allocate) {
      db.prepare("INSERT INTO akiflow_identifiers (external_id) VALUES (?)").run(externalId);
      row = select.get(externalId) as { number: number };
    }
    if (!row) throw new Error(`Missing Akiflow identifier for ${externalId}; sync the source first`);
    return `AKI-${row.number}`;
  }

  function refIdentifier(ref: DbRef, metadata = jsonRecord(JSON.parse(ref.metadata))) {
    if (ref.provider === "linear" && typeof metadata.identifier === "string") return metadata.identifier;
    if (ref.provider === "github" && metadata.number) {
      return typeof metadata.ownerRepo === "string" ? `${metadata.ownerRepo}#${metadata.number}` : `#${metadata.number}`;
    }
    if (ref.provider === "akiflow") return akiflowIdentifier(ref.external_id);
    return `${ref.provider}:${ref.external_id}`;
  }

  function taskDto(task: DbTask) {
    const refs = refsFor(task.id);
    const storedOwner = task.owner_id ? db.prepare("SELECT * FROM owners WHERE id = ?").get(task.owner_id) as DbOwner | undefined : undefined;
    const sourceOwner = refs.flatMap((ref) => {
      if (ref.provider !== "github") return [];
      const assignee = githubAssignee(jsonRecord(JSON.parse(ref.metadata)));
      return assignee ? [assignee] : [];
    })[0] ?? null;
    const displayTitle = refs.reduce((title, ref) => {
      if (title !== ref.title) return title;
      const metadata = jsonRecord(JSON.parse(ref.metadata));
      const prefix = ref.provider === "github" && metadata.ownerRepo && metadata.number
        ? `${metadata.ownerRepo}#${metadata.number}: `
        : ref.provider === "linear" && metadata.identifier ? `${metadata.identifier}: ` : "";
      return prefix && ref.title.startsWith(prefix) ? ref.title.slice(prefix.length) : title;
    }, task.title);
    const refDtos = refs.map((ref) => {
      const metadata = jsonRecord(JSON.parse(ref.metadata));
      const description = typeof metadata.description === "string" ? metadata.description : task.description;
      const relatedUrls = [...new Set([
        ...(Array.isArray(metadata.relatedUrls) ? metadata.relatedUrls.filter((url): url is string => typeof url === "string") : []),
        ...collectUrls(description),
      ])];
      return {
        provider: ref.provider,
        externalId: ref.external_id,
        identifier: refIdentifier(ref, metadata),
        title: ref.title,
        description,
        url: ref.url,
        relatedUrls,
        issueKey: ref.provider === "github" && metadata.number
          ? `#${metadata.number}`
          : ref.provider === "linear" && typeof metadata.identifier === "string"
            ? metadata.identifier
            : ref.provider === "akiflow" ? akiflowIdentifier(ref.external_id) : null,
        repository: ref.provider === "github" && typeof metadata.ownerRepo === "string" ? metadata.ownerRepo : null,
        sourceProject: ref.provider === "linear" && typeof metadata.projectName === "string"
          ? metadata.projectName
          : ref.provider === "akiflow" && typeof metadata.projectPath === "string" ? metadata.projectPath : null,
        sourceTeam: ref.provider === "linear" && typeof metadata.teamName === "string"
          ? metadata.teamName
          : ref.provider === "linear" && typeof metadata.teamKey === "string" ? metadata.teamKey : null,
        priority: ref.provider === "akiflow"
          ? akiflowPriorities[String(metadata.priority) as keyof typeof akiflowPriorities] ?? null
          : ref.provider === "linear"
            ? linearPriorities[String(metadata.priority) as keyof typeof linearPriorities] ?? null
            : ref.provider === "github" && priorityNames.includes(metadata.priority as Priority)
              ? metadata.priority as Priority
              : null,
        recurring: ref.provider === "akiflow" && Boolean(metadata.recurringId || metadata.recurrence),
        projectPath: ref.provider === "akiflow" && typeof metadata.projectPath === "string"
          ? metadata.projectPath
          : null,
        tags: ref.provider === "akiflow" && Array.isArray(metadata.tags)
          ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
      };
    });
    const identifiers = refDtos.map((ref) => ref.identifier);
    const threads = taskThreads(task.id);
    return {
      id: task.id,
      identifier: identifiers[0] ?? task.id,
      identifiers,
      title: displayTitle,
      description: task.description,
      status: task.status,
      projectId: task.project_id,
      threadId: threads[0]?.thread_id ?? null,
      environmentId: threads[0]?.environment_id ?? null,
      threadIds: threads.map((thread) => thread.thread_id),
      owner: storedOwner ? ownerDto(storedOwner) : sourceOwner,
      mergePending: Boolean(task.merge_pending),
      position: task.list_position,
      refs: refDtos,
    };
  }

  function taskRows() {
    return db.prepare(`SELECT * FROM tasks WHERE EXISTS
      (SELECT 1 FROM task_refs WHERE task_refs.task_id = tasks.id) ORDER BY
      CASE status WHEN 'triage' THEN 0 WHEN 'backlog' THEN 1 WHEN 'todo' THEN 2
        WHEN 'doing' THEN 3 WHEN 'blocked' THEN 4 WHEN 'review' THEN 5
        WHEN 'done' THEN 6 ELSE 7 END,
      sort_order ASC, updated_at DESC`).all() as DbTask[];
  }

  function listTasks() {
    return taskRows().map(taskDto);
  }

  function effectiveProjectId(task: DbTask, projects: ProjectInfo[]) {
    try { return resolveProjectFrom(task, projects).id; } catch { return null; }
  }

  function boardTask(task: DbTask, projects: ProjectInfo[]) {
    const dto = taskDto(task);
    return {
      id: dto.id,
      identifier: dto.identifier,
      title: dto.title,
      status: dto.status,
      projectId: dto.projectId,
      effectiveProjectId: effectiveProjectId(task, projects),
      threadIds: dto.threadIds,
      owner: dto.owner && { isMe: dto.owner.isMe },
      position: dto.position,
      refs: dto.refs.map(({ provider, priority, url }) => ({ provider, priority, url })),
    };
  }

  async function boardTasks() {
    const projects = await availableProjects().catch(() => [] as ProjectInfo[]);
    const open = taskRows().filter((task) => task.status !== "done" && task.status !== "cancelled");
    return { tasks: open.map((task) => boardTask(task, projects)).filter(isOpenPersonalTask), hiddenProjectIds: hiddenProjectIds(), linkedThreadIds: linkedThreadIds() };
  }

  function linkedThreadIds() {
    return (db.prepare("SELECT DISTINCT thread_id FROM task_threads ORDER BY thread_id").all() as Array<{ thread_id: string }>)
      .map((row) => row.thread_id);
  }

  function hiddenProjectIds() {
    return (db.prepare("SELECT project_id FROM hidden_projects ORDER BY project_id").all() as Array<{ project_id: string }>)
      .map((row) => row.project_id);
  }

  function setProjectHidden(projectId: string, hidden: boolean) {
    if (hidden) db.prepare("INSERT OR IGNORE INTO hidden_projects (project_id, hidden_at) VALUES (?, ?)").run(projectId, now());
    else db.prepare("DELETE FROM hidden_projects WHERE project_id = ?").run(projectId);
    bb.realtime.publish("tasks-changed", { reason: "hidden-projects" });
    return { hiddenProjectIds: hiddenProjectIds() };
  }

  function nowTasks() {
    return taskRows().map(taskDto).filter((task) => isOpenPersonalTask(task) && task.refs.some((ref) => ref.priority === "urgent"))
      .sort(byPosition);
  }

  async function printNow() {
    const tasks = nowTasks();
    if (!tasks.length) throw new Error("Mark a task urgent before printing Now");
    const { printApiKey, printUrl } = await settings.get();
    if (!printApiKey) throw new Error("Set the receipt printer print API key in Tasks settings first");
    let endpoint: URL;
    try { endpoint = new URL(printUrl); } catch { throw new Error("Set the receipt printer HTTPS endpoint in Tasks settings first"); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error("The receipt printer endpoint must use HTTPS without embedded credentials or a fragment");
    }
    const result = await printTransport.json(endpoint.href, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": printApiKey },
      body: JSON.stringify({ title: printTimestamp(new Date()), items: tasks.map((task) => ({ text: task.title, done: false })) }),
    }, { provider: "Printer", mutation: true });
    if (!z.object({ ok: z.literal(true) }).safeParse(result).success) throw new Error("Printer did not accept the list");
    return { accepted: tasks.length };
  }

  function taskSearchValues(task: ReturnType<typeof taskDto>) {
    return [
      task.id,
      task.identifier,
      ...task.identifiers,
      task.title,
      task.description,
      ...task.refs.flatMap((ref) => [ref.externalId, ref.issueKey, ref.repository, ref.url]),
    ].filter((value): value is string => typeof value === "string");
  }

  function findTask(value: string) {
    const query = value.trim().toLowerCase();
    if (!query) throw new Error("Provide a task identifier");
    const direct = db.prepare("SELECT * FROM tasks WHERE id = ?").get(value) as DbTask | undefined;
    if (direct) return direct;
    const matches = listTasks().filter((task) => taskSearchValues(task)
      .some((candidate) => candidate.toLowerCase() === query));
    if (!matches.length) throw new Error(`Unknown task: ${value}`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous task identifier “${value}”; use ${matches.map((task) => task.identifier).join(" or ")}`);
    }
    return getDbTask(matches[0]!.id);
  }

  function nextSortOrder(status: Status) {
    return (db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM tasks WHERE status = ?")
      .get(status) as { value: number }).value;
  }

  function sourceScope(ref: DbRef): SourceScope | null {
    const metadata = jsonRecord(JSON.parse(ref.metadata));
    const ownerRepo = typeof metadata.ownerRepo === "string" ? metadata.ownerRepo : undefined;
    const key = typeof metadata.sourceKey === "string"
      ? metadata.sourceKey
      : ref.provider === "github" && ownerRepo ? `github:repo:${ownerRepo.toLowerCase()}` : null;
    if (!key) return null;
    return {
      key,
      label: typeof metadata.sourceLabel === "string" ? metadata.sourceLabel : key,
      provider: ref.provider,
      ...(ownerRepo ? { ownerRepo } : {}),
    };
  }

  function mappedProjectId(sourceKey: string) {
    return (db.prepare("SELECT bb_project_id FROM project_mappings WHERE source_key = ?")
      .get(sourceKey) as { bb_project_id: string } | undefined)?.bb_project_id ?? null;
  }

  function automaticProjectId(source: SourceScope, projects: ProjectInfo[]) {
    if (source.provider !== "github" || !source.ownerRepo) return null;
    const ownerRepo = source.ownerRepo.toLowerCase();
    return projects.find((project) => githubRepoFromRemote(project.gitRemoteUrl) === ownerRepo)?.id ?? null;
  }

  async function availableProjects() {
    return await bb.sdk.projects.list({ includePersonal: true }) as ProjectInfo[];
  }

  async function projectMappings() {
    const projects = await availableProjects();
    const enabledProviders = enabledProviderSet();
    const scopes = new Map<string, SourceScope>();
    for (const ref of db.prepare("SELECT * FROM task_refs ORDER BY provider, title").all() as DbRef[]) {
      if (!enabledProviders.has(ref.provider)) continue;
      const source = sourceScope(ref);
      if (source) scopes.set(source.key, source);
    }
    for (const repository of (enabledProviders.has("github")
      ? db.prepare("SELECT * FROM github_repositories ORDER BY full_name").all()
      : []) as DbGithubRepository[]) {
      scopes.set(`github:repo:${repository.full_name.toLowerCase()}`, {
        key: `github:repo:${repository.full_name.toLowerCase()}`,
        label: `GitHub · ${repository.full_name}`,
        provider: "github",
        ownerRepo: repository.full_name,
      });
    }
    for (const source of (enabledProviders.has("linear")
      ? db.prepare("SELECT * FROM linear_sources WHERE enabled = 1 ORDER BY kind, name").all()
      : []) as DbLinearSource[]) {
      scopes.set(source.source_key, {
        key: source.source_key,
        label: `Linear · ${source.name}`,
        provider: "linear",
      });
    }
    for (const source of (enabledProviders.has("akiflow")
      ? db.prepare("SELECT * FROM akiflow_sources WHERE enabled = 1 AND source_key != 'akiflow:inbox' ORDER BY name").all()
      : []) as DbAkiflowSource[]) {
      scopes.set(source.source_key, {
        key: source.source_key,
        label: `Akiflow · ${source.name}`,
        provider: "akiflow",
      });
    }
    return {
      projects: projects.map(({ id, name, kind }) => ({ id, name, kind })),
      sources: [...scopes.values()].map((source) => {
        const explicit = mappedProjectId(source.key);
        const automatic = explicit ? null : automaticProjectId(source, projects);
        return {
          key: source.key,
          label: source.label,
          provider: source.provider,
          bbProjectId: explicit ?? automatic,
          automatic: Boolean(automatic),
        };
      }),
    };
  }

  async function githubRepositoryState() {
    const current = await settings.get();
    return {
      configured: Boolean(current.githubToken),
      repositories: (db.prepare("SELECT * FROM github_repositories ORDER BY full_name").all() as DbGithubRepository[])
        .map((repository) => ({
          fullName: repository.full_name,
          url: repository.html_url,
          enabled: Boolean(repository.enabled),
        })),
    };
  }

  async function linearSourceState() {
    const current = await settings.get();
    return {
      configured: Boolean(current.linearToken),
      sources: (db.prepare("SELECT * FROM linear_sources ORDER BY kind, name COLLATE NOCASE, source_key").all() as DbLinearSource[])
        .map((source) => ({
          key: source.source_key,
          kind: source.kind,
          name: source.name,
          detail: source.detail,
          enabled: Boolean(source.enabled),
        })),
    };
  }

  async function akiflowSourceState() {
    const current = await settings.get();
    return {
      configured: Boolean(current.akiflowRefreshToken),
      sources: (db.prepare("SELECT * FROM akiflow_sources ORDER BY name COLLATE NOCASE, source_key").all() as DbAkiflowSource[])
        .map((source) => ({ key: source.source_key, name: source.name, enabled: Boolean(source.enabled) })),
    };
  }

  function selectedAkiflowSources() {
    return new Set((db.prepare("SELECT source_key FROM akiflow_sources WHERE enabled = 1").all() as DbAkiflowSource[])
      .map((source) => source.source_key));
  }

  function akiflowSourceKey(metadata: JsonObject) {
    return typeof metadata.sourceKey === "string" && metadata.sourceKey.startsWith("akiflow:project:")
      ? metadata.sourceKey : "akiflow:inbox";
  }

  function pruneUnselectedAkiflowReferences() {
    const selected = selectedAkiflowSources();
    const stale = (db.prepare("SELECT external_id, metadata FROM task_refs WHERE provider = 'akiflow'")
      .all() as Array<{ external_id: string; metadata: string }>)
      .filter((ref) => !selected.has(akiflowSourceKey(jsonRecord(JSON.parse(ref.metadata)))));
    if (!stale.length) return;
    db.transaction(() => {
      const removeRef = db.prepare("DELETE FROM task_refs WHERE provider = 'akiflow' AND external_id = ?");
      for (const ref of stale) removeRef.run(ref.external_id);
      db.prepare("DELETE FROM tasks WHERE NOT EXISTS (SELECT 1 FROM task_refs WHERE task_refs.task_id = tasks.id)").run();
    })();
  }

  async function setAkiflowSourceEnabled(key: string, enabled: boolean) {
    const result = db.prepare("UPDATE akiflow_sources SET enabled = ?, updated_at = ? WHERE source_key = ?")
      .run(enabled ? 1 : 0, now(), key);
    if (!result.changes) throw new Error(`Unknown Akiflow source: ${key}`);
    pruneUnselectedAkiflowReferences();
    bb.realtime.publish("tasks-changed", { reason: "akiflow-source" });
    return akiflowSourceState();
  }

  async function setAllAkiflowSourcesEnabled(enabled: boolean) {
    db.prepare("UPDATE akiflow_sources SET enabled = ?, updated_at = ?").run(enabled ? 1 : 0, now());
    pruneUnselectedAkiflowReferences();
    bb.realtime.publish("tasks-changed", { reason: "akiflow-sources" });
    return akiflowSourceState();
  }

  function selectedLinearSources() {
    return new Set((db.prepare("SELECT source_key FROM linear_sources WHERE enabled = 1").all() as Array<{ source_key: string }>)
      .map((source) => source.source_key));
  }

  function linearRefScopeKeys(metadata: JsonObject) {
    const keys = new Set<string>();
    if (typeof metadata.sourceKey === "string") keys.add(metadata.sourceKey);
    if (Array.isArray(metadata.sourceKeys)) {
      for (const key of metadata.sourceKeys) if (typeof key === "string") keys.add(key);
    }
    if (typeof metadata.projectId === "string") keys.add(`linear:project:${metadata.projectId}`);
    if (typeof metadata.teamId === "string") keys.add(`linear:team:${metadata.teamId}`);
    return keys;
  }

  function pruneUnselectedLinearReferences(selected = selectedLinearSources()) {
    const staleRefs = (db.prepare("SELECT external_id, metadata FROM task_refs WHERE provider = 'linear'")
      .all() as Array<{ external_id: string; metadata: string }>).filter((ref) => {
      const keys = linearRefScopeKeys(jsonRecord(JSON.parse(ref.metadata)));
      return ![...keys].some((key) => selected.has(key));
    });
    if (!staleRefs.length) return { refs: 0, tasks: 0 };
    return db.transaction(() => {
      const removeRef = db.prepare("DELETE FROM task_refs WHERE provider = 'linear' AND external_id = ?");
      for (const ref of staleRefs) removeRef.run(ref.external_id);
      const orphaned = db.prepare(`SELECT id FROM tasks WHERE NOT EXISTS
        (SELECT 1 FROM task_refs WHERE task_refs.task_id = tasks.id)`).all() as Array<{ id: string }>;
      const removeTask = db.prepare("DELETE FROM tasks WHERE id = ?");
      for (const task of orphaned) removeTask.run(task.id);
      return { refs: staleRefs.length, tasks: orphaned.length };
    })();
  }

  async function setLinearSourceEnabled(key: string, enabled: boolean) {
    const result = db.prepare("UPDATE linear_sources SET enabled = ?, updated_at = ? WHERE source_key = ?")
      .run(enabled ? 1 : 0, now(), key);
    if (!result.changes) throw new Error(`Unknown Linear source: ${key}`);
    await invalidateSyncCursor("linear");
    pruneUnselectedLinearReferences();
    bb.realtime.publish("tasks-changed", { reason: "linear-source" });
    return linearSourceState();
  }

  async function setAllLinearSourcesEnabled(enabled: boolean) {
    db.prepare("UPDATE linear_sources SET enabled = ?, updated_at = ?").run(enabled ? 1 : 0, now());
    await invalidateSyncCursor("linear");
    pruneUnselectedLinearReferences();
    bb.realtime.publish("tasks-changed", { reason: "linear-sources" });
    return linearSourceState();
  }

  // The allowlist is the persistence boundary, not only a presentation filter.
  // Migration seeds scopes already represented in the database; anything else
  // is removed before RPCs, mentions, or cross-plugin attachment search can see it.
  pruneUnselectedLinearReferences();
  pruneUnselectedAkiflowReferences();

  function pruneUnselectedGithubReferences(selected = selectedGithubRepositories()) {
    const staleRefs = (db.prepare("SELECT task_id, external_id, metadata FROM task_refs WHERE provider = 'github'")
      .all() as Array<{ task_id: string; external_id: string; metadata: string }>).filter((ref) => {
      const ownerRepo = jsonRecord(JSON.parse(ref.metadata)).ownerRepo;
      return typeof ownerRepo !== "string" || !selected.has(ownerRepo.toLocaleLowerCase());
    });
    if (!staleRefs.length) return { refs: 0, tasks: 0 };
    return db.transaction(() => {
      const removeRef = db.prepare("DELETE FROM task_refs WHERE provider = 'github' AND external_id = ?");
      for (const ref of staleRefs) removeRef.run(ref.external_id);
      const orphaned = db.prepare(`SELECT id FROM tasks WHERE NOT EXISTS
        (SELECT 1 FROM task_refs WHERE task_refs.task_id = tasks.id)`).all() as Array<{ id: string }>;
      const removeTask = db.prepare("DELETE FROM tasks WHERE id = ?");
      for (const task of orphaned) removeTask.run(task.id);
      return { refs: staleRefs.length, tasks: orphaned.length };
    })();
  }

  async function setGithubRepositoryEnabled(fullName: string, enabled: boolean) {
    const result = db.prepare("UPDATE github_repositories SET enabled = ?, updated_at = ? WHERE full_name = ?")
      .run(enabled ? 1 : 0, now(), fullName);
    if (!result.changes) throw new Error(`Unknown GitHub repository: ${fullName}`);
    await invalidateSyncCursor("github");
    if (!enabled) pruneUnselectedGithubReferences();
    bb.realtime.publish("tasks-changed", { reason: "github-repository" });
    return githubRepositoryState();
  }

  async function setProjectMapping(sourceKey: string, projectId: string | null) {
    if (projectId && !(await availableProjects()).some((project) => project.id === projectId)) {
      throw new Error("That bb project no longer exists");
    }
    if (projectId) {
      db.prepare(`INSERT INTO project_mappings (source_key, bb_project_id, updated_at)
        VALUES (?, ?, ?) ON CONFLICT(source_key) DO UPDATE SET
        bb_project_id = excluded.bb_project_id, updated_at = excluded.updated_at`)
        .run(sourceKey, projectId, now());
    } else {
      db.prepare("DELETE FROM project_mappings WHERE source_key = ?").run(sourceKey);
    }
    bb.realtime.publish("tasks-changed", { reason: "mapping" });
    return projectMappings();
  }

  function resolveProjectFrom(task: DbTask, projects: ProjectInfo[]) {
    const existing = task.project_id ? projects.find((project) => project.id === task.project_id) : null;
    if (existing) return existing;
    const sources = new Map<string, SourceScope>();
    for (const ref of refsFor(task.id)) {
      const source = sourceScope(ref);
      if (source) sources.set(source.key, source);
    }
    if (!sources.size) {
      const personal = projects.find((project) => project.kind === "personal");
      if (!personal) throw new Error("bb's projectless workspace is unavailable");
      return personal;
    }
    const resolved = [...sources.values()].map((source) => ({
      source,
      projectId: mappedProjectId(source.key) ?? automaticProjectId(source, projects),
    }));
    const missing = resolved.find(({ projectId }) => !projectId);
    if (missing) throw new Error(`Map ${missing.source.label} to a bb project in Tasks settings before starting an attached chat`);
    const projectIds = new Set(resolved.map(({ projectId }) => projectId!));
    if (projectIds.size !== 1) throw new Error("Linked sources map to different bb projects; align their mappings before attaching a chat");
    const project = projects.find((item) => item.id === [...projectIds][0]);
    if (!project) throw new Error("The mapped bb project no longer exists; update the mapping before starting work");
    return project;
  }

  async function resolveProject(task: DbTask) {
    return resolveProjectFrom(task, await availableProjects());
  }

  async function tasksForProject(projectId: string) {
    const projects = await availableProjects();
    return taskRows().flatMap((task) => {
      try {
        return resolveProjectFrom(task, projects).id === projectId ? [taskDto(task)] : [];
      } catch {
        return [];
      }
    });
  }
  async function taskForProject(value: string, projectId: string) {
    const query = value.trim().toLowerCase();
    if (!query) throw new Error("Provide a task identifier");
    const matches = (await tasksForProject(projectId)).filter((task) => task.id === value
      || taskSearchValues(task).some((candidate) => candidate.toLowerCase() === query));
    if (!matches.length) throw new Error(`Unknown task in this bb project: ${value}`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous task identifier “${value}”; use ${matches.map((task) => task.identifier).join(" or ")}`);
    }
    return matches[0]!;
  }

  function refMetadata(item: ExternalTask) {
    return JSON.stringify({
      ...item.metadata,
      description: item.description,
      nativeLinks: item.nativeLinks,
      relatedUrls: item.relatedUrls,
    });
  }

  function upsertExternal(item: ExternalTask) {
    if (item.provider === "akiflow") akiflowIdentifier(item.externalId, true);
    const metadata = refMetadata(item);
    const existing = db.prepare("SELECT * FROM task_refs WHERE provider = ? AND external_id = ?")
      .get(item.provider, item.externalId) as DbRef | undefined;
    const timestamp = now();
    if (existing) {
      const titleBefore = getDbTask(existing.task_id).title;
      db.transaction(() => {
        db.prepare(`UPDATE task_refs SET title = ?, url = ?, metadata = ?, updated_at = ?
          WHERE provider = ? AND external_id = ?`)
          .run(item.title, item.url, metadata, timestamp, item.provider, item.externalId);
        if (item.provider === "linear") {
          const current = getDbTask(existing.task_id);
          const incomingStatus = item.status ?? current.status;
          // Linear has no `review` or `blocked` state type — both map out to `started`, which
          // reads back as `doing`. Preserve the finer board stage so a Linear sync does not
          // flatten it.
          const status = (current.status === "review" || current.status === "blocked") && incomingStatus === "doing"
            ? current.status : incomingStatus;
          db.prepare(`UPDATE tasks SET title = ?, description = ?, status = ?, owner_id = ?,
            owner_source = 'linear', sort_order = ?, updated_at = ? WHERE id = ?`)
            .run(item.title.trim(), item.description, status, item.ownerId ?? null,
              status === current.status ? current.sort_order : nextSortOrder(status), timestamp, existing.task_id);
        } else {
          db.prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ? AND title = ?")
            .run(item.title, timestamp, existing.task_id, existing.title);
          if (item.ownerId !== undefined) {
            db.prepare("UPDATE tasks SET owner_id = ?, owner_source = 'linear', updated_at = ? WHERE id = ?")
              .run(item.ownerId, timestamp, existing.task_id);
          }
          // GitHub `stage:` labels and Akiflow `stage:` tags are authoritative for stage
          // when present, so a change made in the source tool flows back to the board. A
          // local open PR still pins `review`.
          if (item.status) {
            const current = getDbTask(existing.task_id);
            const githubTerminalWithLinear = item.provider === "github"
              && (item.status === "done" || item.status === "cancelled")
              && refsFor(existing.task_id).some((other) => other.provider === "linear");
            if (!githubTerminalWithLinear) {
              const status = current.status === "review" && item.status === "doing" ? "review" : item.status;
              if (status !== current.status) {
                db.prepare("UPDATE tasks SET status = ?, sort_order = ?, updated_at = ? WHERE id = ?")
                  .run(status, nextSortOrder(status), timestamp, existing.task_id);
              }
            }
          }
        }
      })();
      // A title changed in the provider renames the task's chats too.
      if (getDbTask(existing.task_id).title !== titleBefore) void syncChatTitles(existing.task_id);
      return { taskId: existing.task_id, created: false };
    }
    return db.transaction(() => {
      const taskId = randomUUID();
      const status = item.status ?? "triage";
      db.prepare(`INSERT INTO tasks
        (id, title, description, status, owner_id, owner_source, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(taskId, item.title.trim(), item.description, status, item.ownerId ?? null,
          item.ownerId !== undefined ? "linear" : "local", nextSortOrder(status), timestamp, timestamp);
      db.prepare(`INSERT INTO task_refs
        (task_id, provider, external_id, title, url, metadata, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(taskId, item.provider, item.externalId, item.title, item.url,
          metadata, timestamp);
      return { taskId, created: true };
    })();
  }

  function mergeTaskRecords(leftId: string, rightId: string) {
    if (leftId === rightId) return leftId;
    const left = getDbTask(leftId);
    const right = getDbTask(rightId);
    if (left.project_id && right.project_id && left.project_id !== right.project_id) {
      throw new Error("These tasks already belong to different bb projects.");
    }
    const keep = taskThreads(right.id).length ? right : left;
    const drop = keep.id === left.id ? right : left;
    const rank = (status: Status) => statuses.indexOf(status);
    const mergedStatus = rank(keep.status) >= rank(drop.status) ? keep.status : drop.status;
    const linearOwner = keep.owner_source === "linear" ? keep : drop.owner_source === "linear" ? drop : null;
    const ownerId = linearOwner ? linearOwner.owner_id : keep.owner_id ?? drop.owner_id;
    const ownerSource = linearOwner ? "linear" : "local";
    db.transaction(() => {
      db.prepare("UPDATE OR IGNORE task_refs SET task_id = ? WHERE task_id = ?").run(keep.id, drop.id);
      db.prepare("DELETE FROM task_refs WHERE task_id = ?").run(drop.id);
      db.prepare("UPDATE OR IGNORE task_threads SET task_id = ? WHERE task_id = ?").run(keep.id, drop.id);
      db.prepare("DELETE FROM task_threads WHERE task_id = ?").run(drop.id);
      db.prepare(`UPDATE tasks SET status = ?, project_id = COALESCE(project_id, ?),
        owner_id = ?, owner_source = ?, merge_pending = MAX(merge_pending, ?),
        sort_order = ?, updated_at = ? WHERE id = ?`)
        .run(mergedStatus, drop.project_id,
          ownerId, ownerSource, drop.merge_pending, nextSortOrder(mergedStatus), now(), keep.id);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(drop.id);
    })();
    return keep.id;
  }

  function linkNativeRefs() {
    const refs = db.prepare("SELECT * FROM task_refs").all() as DbRef[];
    const byUrl = new Map<string, DbRef>();
    for (const ref of refs) if (ref.url) byUrl.set(normalizeUrl(ref.url), ref);
    let linked = 0;
    for (const ref of refs) {
      const metadata = jsonRecord(JSON.parse(ref.metadata));
      const nativeLinks = Array.isArray(metadata.nativeLinks) ? metadata.nativeLinks : [];
      for (const link of nativeLinks) {
        if (typeof link !== "string") continue;
        const other = byUrl.get(normalizeUrl(link));
        if (!other || other.task_id === ref.task_id || other.provider === ref.provider) continue;
        try {
          mergeTaskRecords(ref.task_id, other.task_id);
          linked += 1;
        } catch (error) {
          bb.log.warn(`Kept linked workspaces separate: ${errorMessage(error)}`);
        }
      }
    }
    return linked;
  }

  function githubHeaders(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bb-task-workspaces",
    };
  }

  async function githubPages(urlValue: string, token: string) {
    const records: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const url = new URL(urlValue);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const body = await fetchGithubJson(url.toString(), { headers: githubHeaders(token) });
      if (!Array.isArray(body)) throw new Error("GitHub returned an invalid list response");
      records.push(...body);
      if (body.length < 100) return records;
    }
  }

  async function refreshGithubRepositories(token?: string, publish = true) {
    const githubToken = token ?? (await settings.get()).githubToken;
    if (!githubToken) throw new Error("Set a GitHub token before refreshing repositories");
    const repositories = (await githubPages("https://api.github.com/user/repos", githubToken))
      .map(jsonRecord)
      .flatMap((repository): Array<{ fullName: string; url: string }> => {
        if (typeof repository.full_name !== "string") return [];
        return [{
          fullName: repository.full_name,
          url: `https://github.com/${repository.full_name}`,
        }];
      });
    const enabled = new Map((db.prepare("SELECT full_name, enabled FROM github_repositories").all() as DbGithubRepository[])
      .map((repository) => [repository.full_name.toLowerCase(), repository.enabled]));
    db.transaction(() => {
      db.prepare("DELETE FROM github_repositories").run();
      const insert = db.prepare(`INSERT INTO github_repositories
        (full_name, html_url, enabled, updated_at) VALUES (?, ?, ?, ?)`);
      const timestamp = now();
      for (const repository of repositories) {
        insert.run(repository.fullName, repository.url, enabled.get(repository.fullName.toLowerCase()) ?? 0, timestamp);
      }
    })();
    pruneUnselectedGithubReferences();
    if (publish) bb.realtime.publish("tasks-changed", { reason: "github-repositories-refreshed" });
    return githubRepositoryState();
  }

  function selectedGithubRepositories() {
    return new Set((db.prepare("SELECT full_name FROM github_repositories WHERE enabled = 1").all() as Array<{ full_name: string }>)
      .map((repository) => repository.full_name.toLowerCase()));
  }

  async function githubTasks(token: string, repositories: Set<string>, since: string | null) {
    if (!repositories.size) return [];
    const [viewerValue, body] = await Promise.all([
      fetchGithubJson("https://api.github.com/user", { headers: githubHeaders(token) }),
      mapWithConcurrency([...repositories], GITHUB_REQUEST_CONCURRENCY, async (fullName) => {
        const path = fullName.split("/").map(encodeURIComponent).join("/");
        const url = new URL(`https://api.github.com/repos/${path}/issues`);
        url.searchParams.set("state", since ? "all" : "open");
        if (since) url.searchParams.set("since", since);
        return (await githubPages(url.toString(), token)).map((raw) => ({ raw, fullName }));
      }).then((pages) => pages.flat()),
    ]);
    const viewer = jsonRecord(viewerValue);
    const viewerLogin = typeof viewer.login === "string" ? viewer.login.toLocaleLowerCase() : null;
    return body.flatMap(({ raw, fullName }): ExternalTask[] => {
      const issue = jsonRecord(raw);
      if (issue.pull_request) return [];
      const labelNames = Array.isArray(issue.labels)
        ? issue.labels.map((label) => typeof label === "string" ? label : String(jsonRecord(label).name ?? "")).filter(Boolean)
        : [];
      const stageLabel = labelNames.find((name) => name.startsWith(STAGE_LABEL_PREFIX))?.slice(STAGE_LABEL_PREFIX.length);
      const priorityLabel = labelNames.find((name) => name.startsWith(PRIORITY_LABEL_PREFIX))?.slice(PRIORITY_LABEL_PREFIX.length);
      const labelledStage = stageLabel && statuses.includes(stageLabel as Status)
        && stageLabel !== "done" && stageLabel !== "cancelled" ? stageLabel as Status : undefined;
      const stage: Status | undefined = issue.state === "closed"
        ? issue.state_reason === "not_planned" ? "cancelled" : "done"
        : labelledStage;
      const priority = priorityLabel && priorityNames.includes(priorityLabel as Priority) ? priorityLabel as Priority : null;
      const title = typeof issue.title === "string" ? issue.title : "Untitled GitHub issue";
      const url = typeof issue.html_url === "string" ? issue.html_url : null;
      const issueBody = typeof issue.body === "string" ? issue.body : "";
      const relatedUrls = collectUrls(issueBody);
      const nativeLinks = relatedUrls.filter((link) => /linear\.app/i.test(link));
      const rawAssignee = jsonRecord(issue.assignee);
      const assigneeLogin = typeof rawAssignee.login === "string" ? rawAssignee.login : null;
      const assigneeKey = typeof rawAssignee.node_id === "string"
        ? rawAssignee.node_id
        : typeof rawAssignee.id === "number" || typeof rawAssignee.id === "string" ? String(rawAssignee.id) : assigneeLogin;
      const assigneeIsMe = Boolean(assigneeLogin && viewerLogin && assigneeLogin.toLocaleLowerCase() === viewerLogin);
      const assignee = assigneeKey && assigneeLogin ? {
        id: `github:${assigneeKey}`,
        name: assigneeIsMe && typeof viewer.name === "string" && viewer.name.trim() ? viewer.name.trim() : assigneeLogin,
        isMe: assigneeIsMe,
      } : null;
      return [{
        provider: "github",
        externalId: String(issue.node_id ?? issue.id),
        title,
        description: issueBody,
        url,
        nativeLinks,
        relatedUrls,
        updatedAt: typeof issue.updated_at === "string" ? issue.updated_at : null,
        ...(stage ? { status: stage } : {}),
        metadata: {
          ownerRepo: fullName,
          number: issue.number,
          assignee,
          priority,
          ...(fullName ? {
            sourceKey: `github:repo:${fullName.toLowerCase()}`,
            sourceLabel: `GitHub · ${fullName}`,
          } : {}),
        },
      }];
    });
  }

  async function linearGraphql(token: string, query: string, variables: JsonObject = {}) {
    const body = jsonRecord(await fetchJson(LINEAR_API, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }, "Linear", /^\s*mutation\b/.test(query)));
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new Error(body.errors.map((item) => String(jsonRecord(item).message ?? "Linear error")).join("; "));
    }
    return jsonRecord(body.data);
  }

  async function refreshLinearSources(token?: string) {
    const linearToken = token ?? (await settings.get()).linearToken;
    if (!linearToken) throw new Error("Set a Linear API key before refreshing teams and projects");

    const discovered: Array<{
      key: string;
      kind: "team" | "project";
      externalId: string;
      name: string;
      detail: string | null;
    }> = [];
    let after: string | null = null;
    do {
      const data = await linearGraphql(linearToken, `query LinearTeams($after: String) {
        teams(first: 250, after: $after) {
          nodes { id key name }
          pageInfo { hasNextPage endCursor }
        }
      }`, { after });
      const connection = jsonRecord(data.teams);
      if (!Array.isArray(connection.nodes)) throw new Error("Linear returned an invalid teams response");
      for (const raw of connection.nodes) {
        const team = jsonRecord(raw);
        if (typeof team.id !== "string" || typeof team.name !== "string") continue;
        discovered.push({
          key: `linear:team:${team.id}`,
          kind: "team",
          externalId: team.id,
          name: team.name,
          detail: typeof team.key === "string" ? team.key : null,
        });
      }
      const pageInfo = jsonRecord(connection.pageInfo);
      after = pageInfo.hasNextPage && typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
    } while (after);

    after = null;
    do {
      const data = await linearGraphql(linearToken, `query LinearProjects($after: String) {
        projects(first: 250, after: $after) {
          nodes {
            id name
            teams(first: 10) { nodes { id key name } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`, { after });
      const connection = jsonRecord(data.projects);
      if (!Array.isArray(connection.nodes)) throw new Error("Linear returned an invalid projects response");
      for (const raw of connection.nodes) {
        const project = jsonRecord(raw);
        if (typeof project.id !== "string" || typeof project.name !== "string") continue;
        const teams = jsonRecord(project.teams).nodes;
        const teamLabels = Array.isArray(teams) ? teams.flatMap((rawTeam) => {
          const team = jsonRecord(rawTeam);
          if (typeof team.name === "string") return [team.name];
          if (typeof team.key === "string") return [team.key];
          return [];
        }) : [];
        discovered.push({
          key: `linear:project:${project.id}`,
          kind: "project",
          externalId: project.id,
          name: project.name,
          detail: teamLabels.length ? teamLabels.join(", ") : null,
        });
      }
      const pageInfo = jsonRecord(connection.pageInfo);
      after = pageInfo.hasNextPage && typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
    } while (after);

    const enabled = new Map((db.prepare("SELECT source_key, enabled FROM linear_sources").all() as DbLinearSource[])
      .map((source) => [source.source_key, source.enabled]));
    db.transaction(() => {
      db.prepare("DELETE FROM linear_sources").run();
      const insert = db.prepare(`INSERT INTO linear_sources
        (source_key, kind, external_id, name, detail, enabled, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const timestamp = now();
      for (const source of discovered) {
        insert.run(source.key, source.kind, source.externalId, source.name, source.detail,
          enabled.get(source.key) ?? 0, timestamp);
      }
    })();
    pruneUnselectedLinearReferences();
    bb.realtime.publish("tasks-changed", { reason: "linear-sources-refreshed" });
    return linearSourceState();
  }

  function requireLinearIssueUpdate(data: JsonObject, action: string) {
    if (jsonRecord(data.issueUpdate).success !== true) throw new Error(`Linear did not ${action}`);
  }

  async function syncLinearOwners(token: string) {
    let after: string | null = null;
    let viewerId: string | null = null;
    const members: Array<{ id: string; name: string }> = [];
    do {
      const data = await linearGraphql(token, `query WorkspaceMembers($after: String) {
        viewer { id }
        users(first: 250, after: $after) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
        }
      }`, { after });
      const viewer = jsonRecord(data.viewer);
      const connection = jsonRecord(data.users);
      if (typeof viewer.id === "string") viewerId = viewer.id;
      if (!Array.isArray(connection.nodes)) throw new Error("Linear returned an invalid users response");
      for (const raw of connection.nodes) {
        const member = jsonRecord(raw);
        if (typeof member.id === "string" && typeof member.name === "string") members.push({ id: member.id, name: member.name });
      }
      const pageInfo = jsonRecord(connection.pageInfo);
      after = pageInfo.hasNextPage && typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
    } while (after);
    const timestamp = now();
    db.transaction(() => {
      db.prepare("UPDATE owners SET active = 0, is_me = 0, updated_at = ?").run(timestamp);
      const upsert = db.prepare(`INSERT INTO owners (id, name, is_me, active, updated_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_me = excluded.is_me,
          active = 1, updated_at = excluded.updated_at`);
      members.forEach((member) => upsert.run(member.id, member.name, member.id === viewerId ? 1 : 0, timestamp));
    })();
  }

  function linearExternalTask(raw: unknown): ExternalTask {
    const issue = jsonRecord(raw);
    const attachments = jsonRecord(issue.attachments).nodes;
    const attachmentUrls = Array.isArray(attachments)
      ? attachments.flatMap((item) => typeof jsonRecord(item).url === "string" ? [String(jsonRecord(item).url)] : [])
      : [];
    const description = typeof issue.description === "string" ? issue.description : "";
    const relatedUrls = [...new Set([...attachmentUrls, ...collectUrls(description)])];
    const nativeLinks = relatedUrls.filter((url) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/i.test(url));
    const project = jsonRecord(issue.project);
    const team = jsonRecord(issue.team);
    const state = jsonRecord(issue.state);
    const assignee = jsonRecord(issue.assignee);
    const projectId = typeof project.id === "string" ? project.id : null;
    const teamId = typeof team.id === "string" ? team.id : null;
    const sourceKeys = [
      ...(projectId ? [`linear:project:${projectId}`] : []),
      ...(teamId ? [`linear:team:${teamId}`] : []),
    ];
    const sourceKey = projectId ? `linear:project:${projectId}` : teamId ? `linear:team:${teamId}` : null;
    const sourceName = projectId ? project.name : team.name ?? team.key;
    return {
      provider: "linear",
      externalId: String(issue.id),
      title: String(issue.title),
      description,
      url: typeof issue.url === "string" ? issue.url : null,
      nativeLinks,
      relatedUrls,
      updatedAt: typeof issue.updatedAt === "string" ? issue.updatedAt : null,
      status: statusFromLinearType(state.type),
      ownerId: typeof assignee.id === "string" ? assignee.id : null,
      metadata: {
        identifier: issue.identifier,
        stateId: typeof state.id === "string" ? state.id : null,
        stateType: typeof state.type === "string" ? state.type : null,
        stateName: typeof state.name === "string" ? state.name : null,
        priority: typeof issue.priority === "number" ? issue.priority : null,
        projectId,
        projectName: typeof project.name === "string" ? project.name : null,
        teamId,
        teamName: typeof team.name === "string" ? team.name : null,
        teamKey: typeof team.key === "string" ? team.key : null,
        sourceKeys,
        ...(sourceKey ? {
          sourceKey,
          sourceLabel: `Linear · ${String(sourceName ?? sourceKey)}`,
        } : {}),
      },
    };
  }

  async function linearTasks(token: string, selected: Set<string>, since: string | null) {
    await syncLinearOwners(token);
    if (!selected.size) return [];
    const teamIds = [...selected].filter((key) => key.startsWith("linear:team:"))
      .map((key) => key.slice("linear:team:".length));
    const projectIds = [...selected].filter((key) => key.startsWith("linear:project:"))
      .map((key) => key.slice("linear:project:".length));
    const operation = since
      ? `query ChangedTasks($after: String, $since: DateTimeOrDuration!, $teamIds: [ID!]!, $projectIds: [ID!]!) {
          issues(first: 250, after: $after, orderBy: updatedAt, includeArchived: true, filter: {
            updatedAt: { gt: $since }
            or: [{ team: { id: { in: $teamIds } } }, { project: { id: { in: $projectIds } } }]
          }) {
            nodes { ...TaskFields }
            pageInfo { hasNextPage endCursor }
          }
        }`
      : `query OpenTasks($after: String, $teamIds: [ID!]!, $projectIds: [ID!]!) {
          issues(first: 250, after: $after, orderBy: updatedAt, filter: {
            state: { type: { nin: ["completed", "canceled"] } }
            or: [{ team: { id: { in: $teamIds } } }, { project: { id: { in: $projectIds } } }]
          }) {
            nodes { ...TaskFields }
            pageInfo { hasNextPage endCursor }
          }
        }`;
    const query = `${operation}\n${LINEAR_TASK_FIELDS}`;
    let after: string | null = null;
    const nodes: unknown[] = [];
    do {
      const data = await linearGraphql(token, query, {
        after,
        teamIds,
        projectIds,
        ...(since ? { since } : {}),
      });
      const connection = jsonRecord(data.issues);
      if (!Array.isArray(connection.nodes)) throw new Error("Linear returned an invalid issues response");
      nodes.push(...connection.nodes);
      const pageInfo = jsonRecord(connection.pageInfo);
      after = pageInfo.hasNextPage && typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
    } while (after);

    // An install without a cursor still reconciles known terminal issues once.
    // Subsequent delta queries include completed and canceled changes directly.
    if (!since) {
      const openIds = new Set(nodes.flatMap((raw) => {
        const id = jsonRecord(raw).id;
        return typeof id === "string" ? [id] : [];
      }));
      const knownIds = (db.prepare(`SELECT task_refs.external_id FROM task_refs
        JOIN tasks ON tasks.id = task_refs.task_id
        WHERE task_refs.provider = 'linear' AND tasks.status != 'done'`).all() as Array<{ external_id: string }>)
        .map((row) => row.external_id)
        .filter((id) => !openIds.has(id));
      for (let offset = 0; offset < knownIds.length; offset += 50) {
        const batch = knownIds.slice(offset, offset + 50);
        const definitions = batch.map((_, index) => `$id${index}: String!`).join(", ");
        const selections = batch.map((_, index) => `issue${index}: issue(id: $id${index}) { ...TaskFields }`).join("\n");
        const variables = Object.fromEntries(batch.map((id, index) => [`id${index}`, id]));
        const data = await linearGraphql(token, `query KnownTasks(${definitions}) {
          ${selections}
        }
        ${LINEAR_TASK_FIELDS}`, variables);
        for (let index = 0; index < batch.length; index += 1) {
          const issue = data[`issue${index}`];
          if (typeof jsonRecord(issue).id === "string") nodes.push(issue);
        }
      }
    }
    return nodes.filter((raw) => {
      const issue = jsonRecord(raw);
      const projectId = jsonRecord(issue.project).id;
      const teamId = jsonRecord(issue.team).id;
      return (typeof projectId === "string" && selected.has(`linear:project:${projectId}`))
        || (typeof teamId === "string" && selected.has(`linear:team:${teamId}`));
    }).map(linearExternalTask);
  }

  async function refreshAkiflowToken(refreshToken: string) {
    const body = jsonRecord(await fetchJson(AKIFLOW_REFRESH, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://web.akiflow.com",
        Referer: "https://web.akiflow.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ client_id: "10", refresh_token: refreshToken }),
    }, "Akiflow"));
    const token = body.access_token;
    if (typeof token !== "string" || !token) throw new Error("Akiflow refreshToken returned no access_token");
    return token;
  }

  function akiflowHeaders(token: string) {
    return {
      "Akiflow-Platform": "mac",
      Authorization: `Bearer ${token.replace(/^Bearer\s+/i, "")}`,
      Referer: "https://web.akiflow.com/app/stable/29a83ee24d87ff96/static/js/801.chunk.js",
      "Akiflow-Client-Id": akiflowClientId,
      "Akiflow-Version": "2.71.5",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36",
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  async function akiflowAccessToken() {
    const current = await settings.get();
    if (current.akiflowRefreshToken) return refreshAkiflowToken(current.akiflowRefreshToken);
    throw new Error("Set an Akiflow refresh token in plugin settings first");
  }

  function collectUrls(value: unknown, urls = new Set<string>()) {
    if (typeof value === "string") {
      for (const match of value.matchAll(/https:\/\/[^\s)>"']+/gi)) urls.add(match[0]);
    } else if (Array.isArray(value)) {
      for (const item of value) collectUrls(item, urls);
    } else {
      for (const item of Object.values(jsonRecord(value))) collectUrls(item, urls);
    }
    return [...urls];
  }

  async function akiflowSync(urlValue: string, token: string) {
    const records: JsonObject[] = [];
    let syncToken: string | undefined;
    const seen = new Set<string>();
    do {
      const url = new URL(urlValue);
      url.searchParams.set("limit", "2500");
      if (syncToken) url.searchParams.set("sync_token", syncToken);
      const page = jsonRecord(await fetchJson(url.toString(), { headers: akiflowHeaders(token) }, "Akiflow"));
      if (Array.isArray(page.data)) records.push(...page.data.map(jsonRecord));
      const next = typeof page.sync_token === "string" ? page.sync_token : undefined;
      if (!page.has_next_page || !next || seen.has(next)) break;
      seen.add(next);
      syncToken = next;
    } while (true);
    return records;
  }

  async function akiflowTasks() {
    const token = await akiflowAccessToken();
    const [tasks, labels, tags] = await Promise.all([
      akiflowSync(AKIFLOW_TASKS, token),
      akiflowSync(AKIFLOW_LABELS, token),
      akiflowSync(AKIFLOW_TAGS, token),
    ]);
    cacheAkiflowSources(labels);
    const selected = selectedAkiflowSources();
    const labelsById = new Map(labels.flatMap((label): Array<[string, JsonObject]> => {
      if (!label.id || label.deleted_at) return [];
      return [[String(label.id), label]];
    }));
    const tagNames = new Map(tags.flatMap((tag): Array<[string, string]> => {
      if (!tag.id || tag.deleted_at || !tag.title) return [];
      return [[String(tag.id), String(tag.title)]];
    }));
    const labelPath = (id: string) => {
      const path: string[] = [];
      const seen = new Set<string>();
      let current: JsonObject | undefined = labelsById.get(id);
      while (current?.id && !seen.has(String(current.id))) {
        seen.add(String(current.id));
        if (current.title) path.unshift(String(current.title));
        current = current.parent_id ? labelsById.get(String(current.parent_id)) : undefined;
      }
      return path.join(" / ") || id;
    };
    return tasks.flatMap((task): ExternalTask[] => {
      if (!task.id || !task.title || task.done || task.deleted_at || task.trashed_at) return [];
      const listId = typeof task.listId === "string" && task.listId ? task.listId : null;
      if (!selected.has(listId ? `akiflow:project:${listId}` : "akiflow:inbox")) return [];
      const projectPath = listId ? labelPath(listId) : null;
      const taskTags = Array.isArray(task.tags_ids)
        ? task.tags_ids.flatMap((id) => tagNames.get(String(id)) ?? [])
        : [];
      const stageTag = taskTags.find((tag) => tag.startsWith(STAGE_LABEL_PREFIX))?.slice(STAGE_LABEL_PREFIX.length);
      const stage = stageTag && statuses.includes(stageTag as Status)
        && stageTag !== "done" && stageTag !== "cancelled" ? stageTag as Status : undefined;
      const relatedUrls = collectUrls([task.links, task.description, task.content]);
      const nativeLinks = relatedUrls.filter((url) => /linear\.app|github\.com/i.test(url));
      return [{
        provider: "akiflow",
        externalId: String(task.id),
        title: String(task.title),
        // Akiflow's content field is app metadata such as {"aiListId": ...}, never task text.
        description: typeof task.description === "string" ? task.description : "",
        url: typeof task.url === "string" ? task.url : null,
        nativeLinks,
        relatedUrls,
        ...(stage ? { status: stage } : {}),
        metadata: {
          ...(listId ? {
            sourceKey: `akiflow:project:${listId}`,
            sourceLabel: `Akiflow · ${projectPath}`,
          } : {}),
          projectPath,
          tags: taskTags.filter((tag) => !tag.startsWith(STAGE_LABEL_PREFIX)),
          tagIds: Array.isArray(task.tags_ids) ? task.tags_ids.map(String) : [],
          priority: typeof task.priority === "number" ? task.priority : null,
          recurringId: task.recurring_id ? String(task.recurring_id) : null,
          recurrence: task.recurrence ?? null,
          recurrenceVersion: task.recurrence_version ?? null,
        },
      }];
    });
  }

  function akiflowProjectDestinations(labels: JsonObject[]) {
    const labelsById = new Map(labels.flatMap((label): Array<[string, JsonObject]> => {
      if (!label.id || label.deleted_at) return [];
      return [[String(label.id), label]];
    }));
    const labelPath = (id: string) => {
      const path: string[] = [];
      const seen = new Set<string>();
      let current: JsonObject | undefined = labelsById.get(id);
      while (current?.id && !seen.has(String(current.id))) {
        seen.add(String(current.id));
        if (current.title) path.unshift(String(current.title));
        current = current.parent_id ? labelsById.get(String(current.parent_id)) : undefined;
      }
      return path.join(" / ") || id;
    };
    return [...labelsById.values()].flatMap((label) => {
      if (!label.id || label.type === "folder") return [];
      const id = String(label.id);
      return [{ id: `akiflow:project:${id}`, label: labelPath(id), detail: "Project" }];
    }).sort((left, right) => left.label.localeCompare(right.label));
  }

  function cacheAkiflowSources(labels: JsonObject[]) {
    const sources = [{ id: "akiflow:inbox", label: "Inbox" }, ...akiflowProjectDestinations(labels)];
    db.transaction(() => {
      const upsert = db.prepare(`INSERT INTO akiflow_sources (source_key, name, enabled, updated_at)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(source_key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`);
      const timestamp = now();
      for (const source of sources) upsert.run(source.id, source.label, timestamp);
    })();
  }

  async function refreshAkiflowSources() {
    const token = await akiflowAccessToken();
    const labels = await akiflowSync(AKIFLOW_LABELS, token);
    cacheAkiflowSources(labels);
    bb.realtime.publish("tasks-changed", { reason: "akiflow-sources-refreshed" });
    return akiflowSourceState();
  }

  async function linearProjectDestinations(token: string, sources: DbLinearSource[]) {
    const destinations: Array<{ id: string; label: string; detail: string }> = [];
    for (let offset = 0; offset < sources.length; offset += 50) {
      const batch = sources.slice(offset, offset + 50);
      const definitions = batch.map((_, index) => `$id${index}: String!`).join(", ");
      const selections = batch.map((_, index) => `project${index}: project(id: $id${index}) {
        id name teams(first: 50) { nodes { id key name } }
      }`).join("\n");
      const variables = Object.fromEntries(batch.map((source, index) => [`id${index}`, source.external_id]));
      const data = await linearGraphql(token, `query CreationProjectTeams(${definitions}) {
        ${selections}
      }`, variables);
      batch.forEach((source, index) => {
        const project = jsonRecord(data[`project${index}`]);
        const teams = jsonRecord(project.teams).nodes;
        if (!Array.isArray(teams)) return;
        for (const rawTeam of teams) {
          const team = jsonRecord(rawTeam);
          if (typeof team.id !== "string") continue;
          const teamLabel = typeof team.name === "string" ? team.name : typeof team.key === "string" ? team.key : "Team";
          destinations.push({
            id: `${source.source_key}:team:${team.id}`,
            label: source.name,
            detail: `Project · ${teamLabel}`,
          });
        }
      });
    }
    return destinations.sort((left, right) => left.label.localeCompare(right.label) || left.detail.localeCompare(right.detail));
  }

  async function createTaskOptions() {
    const current = await settings.get();
    const enabled = enabledProviderSet();
    const result: Array<{
      provider: Provider;
      destinations: Array<{ id: string; label: string; detail: string | null }>;
      error: string | null;
    }> = [];
    for (const provider of providers) {
      if (!enabled.has(provider)) continue;
      if (provider === "github") {
        result.push({
          provider,
          destinations: (db.prepare("SELECT * FROM github_repositories WHERE enabled = 1 ORDER BY full_name COLLATE NOCASE").all() as DbGithubRepository[])
            .map((repository) => ({ id: `github:repo:${repository.full_name}`, label: repository.full_name, detail: "Repository" })),
          error: current.githubToken ? null : "Configure a GitHub token before creating issues.",
        });
        continue;
      }
      if (provider === "linear") {
        if (!current.linearToken) {
          result.push({ provider, destinations: [], error: "Configure a Linear API key before creating issues." });
          continue;
        }
        const selected = db.prepare("SELECT * FROM linear_sources WHERE enabled = 1 ORDER BY kind, name COLLATE NOCASE").all() as DbLinearSource[];
        const teams = selected.filter((source) => source.kind === "team")
          .map((source) => ({ id: source.source_key, label: source.name, detail: source.detail ? `Team · ${source.detail}` : "Team" }));
        try {
          const projects = await linearProjectDestinations(current.linearToken, selected.filter((source) => source.kind === "project"));
          result.push({ provider, destinations: [...teams, ...projects], error: null });
        } catch (error) {
          result.push({ provider, destinations: teams, error: `Linear projects unavailable: ${errorMessage(error)}` });
        }
        continue;
      }
      if (!current.akiflowRefreshToken) {
        result.push({ provider, destinations: [], error: "Configure an Akiflow refresh token before creating tasks." });
        continue;
      }
      try {
        const token = await akiflowAccessToken();
        const labels = await akiflowSync(AKIFLOW_LABELS, token);
        cacheAkiflowSources(labels);
        const selected = selectedAkiflowSources();
        result.push({
          provider,
          destinations: [{ id: "akiflow:inbox", label: "Inbox", detail: "Akiflow" }, ...akiflowProjectDestinations(labels)]
            .filter((destination) => selected.has(destination.id)),
          error: null,
        });
      } catch (error) {
        result.push({ provider, destinations: [], error: errorMessage(error) });
      }
    }
    const projects = await availableProjects().catch(() => [] as ProjectInfo[]);
    return {
      providers: result.map((entry) => ({
        ...entry,
        destinations: entry.destinations.map((destination) => ({
          ...destination,
          projectId: destinationProjectId(entry.provider, destination.id, projects),
        })),
      })),
    };
  }
  function destinationProjectId(provider: Provider, destinationId: string, projects: ProjectInfo[]) {
    if (provider === "akiflow" && destinationId === "akiflow:inbox") {
      return projects.find((project) => project.kind === "personal")?.id ?? null;
    }
    const sourceKey = provider === "github"
      ? destinationId.toLowerCase()
      : provider === "linear" && destinationId.startsWith("linear:project:")
        ? destinationId.split(":team:")[0]!
        : destinationId;
    const ownerRepo = provider === "github" && sourceKey.startsWith("github:repo:")
      ? sourceKey.slice("github:repo:".length)
      : undefined;
    const source: SourceScope = {
      key: sourceKey,
      label: sourceKey,
      provider,
      ...(ownerRepo ? { ownerRepo } : {}),
    };
    return mappedProjectId(sourceKey) ?? automaticProjectId(source, projects);
  }

  async function assertDestinationProject(provider: Provider, destinationId: string, projectId: string) {
    if (destinationProjectId(provider, destinationId, await availableProjects()) === projectId) return;
    if (provider === "akiflow" && destinationId === "akiflow:inbox") throw new Error("Akiflow Inbox belongs to bb's personal task workspace");
    throw new Error("That task destination belongs to a different bb project or has not been mapped");
  }

  // A task made from a project's card is created in the provider, then placed in that project.
  // A Linear issue is assigned to me, because Tasks shows only the Linear issues that are mine.
  // A task made from a chat is linked to it. The chat is read first, so a missing chat makes no task.
  // With priority, the task starts in Now (urgent) or Later (high).
  async function createProjectTask(projectId: string, destinationId: string, title: string, threadId?: string, priority?: "urgent" | "high") {
    const provider = providers.find((name) => destinationId.startsWith(`${name}:`));
    if (!provider) throw new Error("Choose where to create the task");
    const projects = await projectsWith(projectId);
    const thread = threadId ? await topLevelThread(threadId) : null;
    const created = await createTask({
      provider,
      destinationId,
      title,
      description: "",
      priority: priority ?? null,
      ownerId: provider === "linear" ? currentOwnerId() : null,
    });
    // The first chat places a task in its project. Here the chosen project wins over the chat's.
    if (thread) await persistTaskAttachment(created.id, { ...thread, projectId, startedByTask: false });
    placeInProject(created.id, projectId, projects);
    return boardTask(getDbTask(created.id), projects);
  }

  function createdTask(item: ExternalTask) {
    const { taskId } = upsertExternal(item);
    if (item.provider === "akiflow") {
      const ownerId = currentOwnerId();
      if (ownerId) {
        db.prepare("UPDATE tasks SET owner_id = ?, owner_source = 'local', updated_at = ? WHERE id = ? AND owner_id IS NULL")
          .run(ownerId, now(), taskId);
      }
    }
    bb.realtime.publish("tasks-changed", { reason: "created", taskId, provider: item.provider });
    return taskDto(getDbTask(taskId));
  }

  async function createGithubTask(input: CreateTaskInput, token: string): Promise<ExternalTask> {
    const fullName = input.destinationId.startsWith("github:repo:") ? input.destinationId.slice("github:repo:".length) : "";
    const repository = db.prepare("SELECT * FROM github_repositories WHERE full_name = ? AND enabled = 1").get(fullName) as DbGithubRepository | undefined;
    if (!repository) throw new Error("Choose an enabled GitHub repository");
    if (input.ownerId) throw new Error("Choose owners after the GitHub issue is created");
    const path = fullName.split("/").map(encodeURIComponent).join("/");
    const issue = jsonRecord(await fetchGithubJson(`https://api.github.com/repos/${path}/issues`, {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title.trim(),
        body: input.description,
        ...(input.priority ? { labels: [`${PRIORITY_LABEL_PREFIX}${input.priority}`] } : {}),
      }),
    }));
    if ((!issue.node_id && !issue.id) || typeof issue.number !== "number") throw new Error("GitHub created an issue but returned no identifier");
    const title = typeof issue.title === "string" ? issue.title : input.title.trim();
    const description = typeof issue.body === "string" ? issue.body : input.description;
    const relatedUrls = collectUrls(description);
    return {
      provider: "github",
      externalId: String(issue.node_id ?? issue.id),
      title,
      description,
      url: typeof issue.html_url === "string" ? issue.html_url : `https://github.com/${fullName}/issues/${issue.number}`,
      nativeLinks: relatedUrls.filter((url) => /linear\.app/i.test(url)),
      relatedUrls,
      metadata: {
        ownerRepo: repository.full_name,
        number: issue.number,
        priority: input.priority ?? null,
        sourceKey: `github:repo:${repository.full_name.toLowerCase()}`,
        sourceLabel: `GitHub · ${repository.full_name}`,
      },
    };
  }

  async function createLinearTask(input: CreateTaskInput, token: string): Promise<ExternalTask> {
    let teamId: string;
    let projectId: string | null = null;
    let source: DbLinearSource | undefined;
    const projectMatch = input.destinationId.match(/^linear:project:([^:]+):team:([^:]+)$/);
    if (projectMatch) {
      projectId = projectMatch[1]!;
      teamId = projectMatch[2]!;
      source = db.prepare("SELECT * FROM linear_sources WHERE source_key = ? AND kind = 'project' AND enabled = 1")
        .get(`linear:project:${projectId}`) as DbLinearSource | undefined;
      if (!source) throw new Error("Choose an enabled Linear project");
      const valid = await linearProjectDestinations(token, [source]);
      if (!valid.some((destination) => destination.id === input.destinationId)) throw new Error("That Linear project is no longer associated with the selected team");
    } else {
      source = db.prepare("SELECT * FROM linear_sources WHERE source_key = ? AND kind = 'team' AND enabled = 1")
        .get(input.destinationId) as DbLinearSource | undefined;
      if (!source) throw new Error("Choose an enabled Linear team or project");
      teamId = source.external_id;
    }
    if (input.ownerId && !db.prepare("SELECT 1 FROM owners WHERE id = ? AND active = 1").get(input.ownerId)) {
      throw new Error("Choose an active Linear workspace member");
    }
    const createInput: JsonObject = {
      teamId,
      title: input.title.trim(),
      description: input.description,
      ...(projectId ? { projectId } : {}),
      ...(input.priority ? { priority: linearPriorityValues[input.priority as keyof typeof linearPriorityValues] } : {}),
      ...(input.ownerId ? { assigneeId: input.ownerId } : {}),
    };
    const data = await linearGraphql(token, `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id identifier title description url priority
          state { id type name }
          assignee { id }
          project { id name }
          team { id key name }
          attachments(first: 1) { nodes { url title } }
        }
      }
    }`, { input: createInput });
    const payload = jsonRecord(data.issueCreate);
    const issue = jsonRecord(payload.issue);
    if (payload.success !== true || typeof issue.id !== "string" || typeof issue.identifier !== "string") {
      throw new Error("Linear did not create the issue");
    }
    const project = jsonRecord(issue.project);
    const team = jsonRecord(issue.team);
    const state = jsonRecord(issue.state);
    const assignee = jsonRecord(issue.assignee);
    const createdProjectId = typeof project.id === "string" ? project.id : null;
    const createdTeamId = typeof team.id === "string" ? team.id : teamId;
    const sourceKeys = [
      ...(createdProjectId ? [`linear:project:${createdProjectId}`] : []),
      ...(createdTeamId ? [`linear:team:${createdTeamId}`] : []),
    ];
    const sourceKey = createdProjectId ? `linear:project:${createdProjectId}` : `linear:team:${createdTeamId}`;
    const sourceName = createdProjectId ? project.name : team.name ?? team.key;
    const description = typeof issue.description === "string" ? issue.description : input.description;
    const relatedUrls = collectUrls(description);
    return {
      provider: "linear",
      externalId: issue.id,
      title: typeof issue.title === "string" ? issue.title : input.title.trim(),
      description,
      url: typeof issue.url === "string" ? issue.url : null,
      nativeLinks: relatedUrls.filter((url) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/i.test(url)),
      relatedUrls,
      status: statusFromLinearType(state.type),
      ownerId: typeof assignee.id === "string" ? assignee.id : null,
      metadata: {
        identifier: issue.identifier,
        stateId: typeof state.id === "string" ? state.id : null,
        stateType: typeof state.type === "string" ? state.type : null,
        stateName: typeof state.name === "string" ? state.name : null,
        priority: typeof issue.priority === "number" ? issue.priority : null,
        projectId: createdProjectId,
        projectName: typeof project.name === "string" ? project.name : null,
        teamId: createdTeamId,
        teamName: typeof team.name === "string" ? team.name : null,
        teamKey: typeof team.key === "string" ? team.key : null,
        sourceKeys,
        sourceKey,
        sourceLabel: `Linear · ${String(sourceName ?? sourceKey)}`,
      },
    };
  }

  async function createAkiflowTask(input: CreateTaskInput): Promise<ExternalTask> {
    if (input.ownerId) throw new Error("Akiflow task ownership is managed locally after creation");
    if (!selectedAkiflowSources().has(input.destinationId)) throw new Error("Select this Akiflow project or Inbox in Preferences first");
    const token = await akiflowAccessToken();
    const labels = await akiflowSync(AKIFLOW_LABELS, token);
    const destinations = akiflowProjectDestinations(labels);
    const destination = input.destinationId === "akiflow:inbox"
      ? { id: "akiflow:inbox", label: "Inbox", detail: "Akiflow" }
      : destinations.find((option) => option.id === input.destinationId);
    if (!destination) throw new Error("Choose a current Akiflow project or Inbox");
    const externalId = randomUUID();
    const timestamp = now();
    const sorting = Date.now();
    const listId = input.destinationId.startsWith("akiflow:project:")
      ? input.destinationId.slice("akiflow:project:".length)
      : null;
    const task: JsonObject = {
      id: externalId,
      status: 1,
      title: input.title.trim(),
      description: input.description,
      sorting,
      sorting_label: sorting,
      duration: 0,
      date: null,
      datetime: null,
      plan_unit: null,
      plan_period: null,
      tags_ids: null,
      time_slot_id: null,
      links: [],
      done: false,
      done_at: null,
      datetime_tz: "UTC",
      data: {},
      original_date: null,
      original_datetime: null,
      recurring_id: null,
      recurrence: null,
      search_text: "",
      due_date: null,
      calendar_id: null,
      recurrence_version: null,
      content: null,
      origin: null,
      connector_id: null,
      origin_id: null,
      origin_account_id: null,
      doc: null,
      trashed_at: null,
      global_created_at: timestamp,
      deleted_at: null,
      global_updated_at: timestamp,
      global_list_id_updated_at: null,
      global_tags_ids_updated_at: null,
      ...(listId ? { listId } : {}),
      ...(input.priority ? { priority: akiflowPriorityValues[input.priority as keyof typeof akiflowPriorityValues] } : {}),
    };
    await fetchJson(AKIFLOW_TASKS, {
      method: "PATCH",
      headers: akiflowHeaders(token),
      body: JSON.stringify([task]),
    }, "Akiflow", true);
    const relatedUrls = collectUrls(input.description);
    return {
      provider: "akiflow",
      externalId,
      title: input.title.trim(),
      description: input.description,
      url: null,
      nativeLinks: relatedUrls.filter((url) => /linear\.app|github\.com/i.test(url)),
      relatedUrls,
      metadata: {
        ...(listId ? {
          sourceKey: `akiflow:project:${listId}`,
          sourceLabel: `Akiflow · ${destination.label}`,
        } : {}),
        projectPath: listId ? destination.label : null,
        tags: [],
        tagIds: [],
        priority: input.priority ? akiflowPriorityValues[input.priority as keyof typeof akiflowPriorityValues] : null,
        recurringId: null,
        recurrence: null,
        recurrenceVersion: null,
      },
    };
  }

  async function createTask(input: CreateTaskInput) {
    return createdTask(await createExternal(input));
  }

  async function createExternal(input: CreateTaskInput) {
    if (!enabledProviderSet().has(input.provider)) throw new Error(`Enable ${input.provider} in Tasks settings before creating tasks`);
    const current = await settings.get();
    if (input.provider === "github") {
      if (!current.githubToken) throw new Error("Configure GitHub before creating issues");
      return createGithubTask(input, current.githubToken);
    }
    if (input.provider === "linear") {
      if (!current.linearToken) throw new Error("Configure Linear before creating issues");
      return createLinearTask(input, current.linearToken);
    }
    return createAkiflowTask(input);
  }

  // githubTasks only fetches open issues, so an issue closed directly in GitHub simply drops
  // out of the sync. Detect that: for tracked GitHub-only issues in enabled repos that were
  // NOT seen this sync and whose task is still open, fetch the issue and mirror its close
  // reason (completed → done, not_planned → cancelled). Skipping terminal tasks and
  // Linear-linked tasks keeps this to a small, bounded number of targeted requests.
  async function reconcileClosedGithubIssues(token: string, seen: Set<string>, selectedRepos: Set<string>) {
    const refs = (db.prepare("SELECT * FROM task_refs WHERE provider = 'github'").all() as DbRef[]).filter((ref) => {
      if (seen.has(ref.external_id)) return false;
      const task = getDbTask(ref.task_id);
      if (task.status === "done" || task.status === "cancelled") return false;
      if (refsFor(ref.task_id).some((other) => other.provider === "linear")) return false;
      const metadata = jsonRecord(JSON.parse(ref.metadata));
      return typeof metadata.ownerRepo === "string"
        && selectedRepos.has(metadata.ownerRepo.toLowerCase())
        && typeof metadata.number === "number";
    });
    let moved = 0;
    await mapWithConcurrency(refs, GITHUB_REQUEST_CONCURRENCY, async (ref) => {
      const metadata = jsonRecord(JSON.parse(ref.metadata));
      const path = String(metadata.ownerRepo).split("/").map(encodeURIComponent).join("/");
      let issue: JsonObject;
      try {
        issue = jsonRecord(await fetchGithubJson(`https://api.github.com/repos/${path}/issues/${metadata.number}`, { headers: githubHeaders(token) }));
      } catch (error) {
        if (error instanceof HttpResponseError && error.status === 404) return;
        throw error;
      }
      if (issue.state !== "closed") return;
      const target: Status = issue.state_reason === "not_planned" ? "cancelled" : "done";
      const task = getDbTask(ref.task_id);
      if (task.status === target) return;
      db.prepare("UPDATE tasks SET status = ?, sort_order = ?, updated_at = ? WHERE id = ?")
        .run(target, nextSortOrder(target), now(), ref.task_id);
      moved += 1;
    });
    return moved;
  }

  async function syncNow() {
    const current = await settings.get();
    const enabledProviders = enabledProviderSet();
    const [githubGeneration, linearGeneration] = await Promise.all([
      syncGeneration("github"),
      syncGeneration("linear"),
    ]);
    const selectedGithub = selectedGithubRepositories();
    const selectedLinear = selectedLinearSources();
    pruneDisabledProviderReferences(enabledProviders);
    pruneUnselectedGithubReferences(selectedGithub);
    pruneUnselectedLinearReferences(selectedLinear);
    pruneUnselectedAkiflowReferences();

    const storedGithubCursor = await bb.storage.kv.get<unknown>("sync-cursor:github");
    const storedLinearCursor = await bb.storage.kv.get<unknown>("sync-cursor:linear");
    const githubCursorTime = typeof storedGithubCursor === "string" ? Date.parse(storedGithubCursor) : Number.NaN;
    const linearCursorTime = typeof storedLinearCursor === "string" ? Date.parse(storedLinearCursor) : Number.NaN;
    const githubSince = Number.isFinite(githubCursorTime) ? new Date(githubCursorTime - 60_000).toISOString() : null;
    const linearSince = Number.isFinite(linearCursorTime) ? new Date(linearCursorTime - 60_000).toISOString() : null;
    const sources: Promise<ExternalTask[]>[] = [];
    const names: Provider[] = [];
    const githubToken = current.githubToken;
    if (enabledProviders.has("github") && githubToken) {
      names.push("github");
      sources.push(githubTasks(githubToken, selectedGithub, githubSince));
    }
    if (enabledProviders.has("linear") && current.linearToken) {
      names.push("linear");
      sources.push(linearTasks(current.linearToken, selectedLinear, linearSince));
    }
    if (enabledProviders.has("akiflow") && current.akiflowRefreshToken) {
      names.push("akiflow");
      sources.push(akiflowTasks());
    }

    const settled = await Promise.allSettled(sources);
    let imported = 0;
    const errors: string[] = [];
    const health = await loadProviderHealth();
    const timestamp = now();
    const cursorByProvider: Partial<Record<Provider, string>> = {};
    const selectedAkiflow = selectedAkiflowSources();
    for (let index = 0; index < settled.length; index += 1) {
      const provider = names[index]!;
      const result = settled[index]!;
      if (result.status === "rejected") {
        const message = errorMessage(result.reason);
        errors.push(`${provider}: ${message}`);
        health[provider] = { ...health[provider], lastError: message, lastErrorAt: timestamp };
        continue;
      }
      health[provider] = { lastOkAt: timestamp };
      const observedTimes = result.value.flatMap((item) => {
        const value = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
        return Number.isFinite(value) ? [value] : [];
      });
      if (observedTimes.length) cursorByProvider[provider] = new Date(Math.max(...observedTimes)).toISOString();
      for (const item of result.value) {
        if (provider === "akiflow" && !selectedAkiflow.has(akiflowSourceKey(item.metadata))) continue;
        const terminal = item.status === "done" || item.status === "cancelled";
        const known = db.prepare("SELECT 1 FROM task_refs WHERE provider = ? AND external_id = ?")
          .get(item.provider, item.externalId);
        if (terminal && !known) continue;
        if (upsertExternal(item).created) imported += 1;
      }
    }


    let githubCursorReady = true;
    const githubIndex = names.indexOf("github");
    const githubResult = githubIndex >= 0 ? settled[githubIndex] : undefined;
    if (!storedGithubCursor && githubToken && githubResult?.status === "fulfilled") {
      const seen = new Set(githubResult.value.filter((item) => item.provider === "github").map((item) => item.externalId));
      try {
        await reconcileClosedGithubIssues(githubToken, seen, selectedGithub);
      } catch (error) {
        githubCursorReady = false;
        const message = `github reconcile: ${errorMessage(error)}`;
        errors.push(message);
        health.github = { ...health.github, lastError: message, lastErrorAt: timestamp };
      }
    }
    if (githubResult?.status === "fulfilled" && githubCursorReady && cursorByProvider.github
      && await syncGeneration("github") === githubGeneration) {
      await bb.storage.kv.set("sync-cursor:github", cursorByProvider.github);
    }
    const linearIndex = names.indexOf("linear");
    if (linearIndex >= 0 && settled[linearIndex]?.status === "fulfilled" && cursorByProvider.linear
      && await syncGeneration("linear") === linearGeneration) {
      await bb.storage.kv.set("sync-cursor:linear", cursorByProvider.linear);
    }
    await bb.storage.kv.set("provider-health", health);

    // A source may have been disabled while its request was in flight.
    pruneUnselectedGithubReferences();
    pruneUnselectedLinearReferences();
    pruneUnselectedAkiflowReferences();
    pruneDisabledProviderReferences();
    const linked = linkNativeRefs();
    const ownerId = currentOwnerId();
    if (ownerId) db.prepare(`UPDATE tasks SET owner_id = ?, owner_source = 'local', updated_at = ?
      WHERE owner_id IS NULL
        AND EXISTS (SELECT 1 FROM task_refs WHERE task_id = tasks.id AND provider = 'akiflow')
        AND NOT EXISTS (SELECT 1 FROM task_refs WHERE task_id = tasks.id AND provider IN ('linear', 'github'))`)
      .run(ownerId, now());
    bb.realtime.publish("tasks-changed", { reason: "sync" });
    return { imported, linked, errors };
  }

  async function loadProviderHealth(): Promise<Record<string, { lastOkAt?: string; lastError?: string; lastErrorAt?: string }>> {
    const stored = await bb.storage.kv.get<unknown>("provider-health");
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? { ...(stored as Record<string, { lastOkAt?: string; lastError?: string; lastErrorAt?: string }>) }
      : {};
  }

  // Derive a health snapshot per provider from configuration and the last sync outcome, so
  // stale/missing credentials or a failing sync surface in the UI instead of failing silently.
  async function providerHealth() {
    const current = await settings.get();
    const enabled = enabledProviderSet();
    const health = await loadProviderHealth();
    const configured: Record<Provider, boolean> = {
      akiflow: Boolean(current.akiflowRefreshToken),
      linear: Boolean(current.linearToken),
      github: Boolean(current.githubToken),
    };
    return providers.map((provider) => {
      const record = health[provider] ?? {};
      const isEnabled = enabled.has(provider);
      const isConfigured = configured[provider];
      const authLike = record.lastError
        ? /\b401\b|\b403\b|unauthor|forbidden|expired|invalid|bad token|refresh|credential/i.test(record.lastError)
        : false;
      const status: "ok" | "disabled" | "unconfigured" | "stale" | "error" =
        !isEnabled ? "disabled"
          : !isConfigured ? "unconfigured"
            : record.lastError ? (authLike ? "stale" : "error")
              : "ok";
      return {
        provider,
        enabled: isEnabled,
        configured: isConfigured,
        status,
        lastError: record.lastError ?? null,
        lastErrorAt: record.lastErrorAt ?? null,
        lastOkAt: record.lastOkAt ?? null,
      };
    });
  }

  function taskAgentContext(task: DbTask, status: Status = task.status) {
    const dto = taskDto(task);
    return buildTaskAgentContext({
      identifier: dto.identifier,
      status,
      providers: dto.refs.map((ref) => ref.provider),
    });
  }

  function taskPrompt(task: DbTask) {
    return ["Please work on this task.", taskAgentContext(task, attachedTaskStage(task.status))].join("\n\n");
  }

  type ThreadAttachmentTarget = {
    id: string;
    projectId: string;
    environmentId: string | null;
    /** True when the chat was started for this task, so renaming the task renames the chat. */
    startedByTask?: boolean;
  };
  // Without awaitStage, the provider stage write-back finishes in the background.
  async function persistTaskAttachment(taskId: string, thread: ThreadAttachmentTarget, { awaitStage = true } = {}) {
    const task = getDbTask(taskId);
    // The first chat places the task in its project. Later chats do not move it.
    const projectId = taskThreads(taskId).some((link) => link.thread_id !== thread.id) ? task.project_id : thread.projectId;
    db.transaction(() => {
      db.prepare("DELETE FROM declined_thread_task WHERE thread_id = ? AND task_id = ?").run(thread.id, taskId);
      db.prepare(`INSERT INTO task_threads (task_id, thread_id, environment_id, started_by_task, attached_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id, thread_id) DO UPDATE SET environment_id = excluded.environment_id`)
        .run(taskId, thread.id, thread.environmentId, thread.startedByTask ? 1 : 0, now());
      db.prepare("UPDATE tasks SET project_id = ?, updated_at = ? WHERE id = ?")
        .run(projectId, now(), taskId);
    })();
    bb.realtime.publish("tasks-changed", { reason: "chat-attached", taskId });
    await syncChatTitles(taskId, thread.id);
    const targetStatus = attachedTaskStage(task.status);
    if (targetStatus !== task.status) {
      const moved = setStatus(taskId, targetStatus).catch((error) => {
        bb.log.warn(`Task attached, but moving it to doing failed: ${errorMessage(error)}`);
      });
      if (awaitStage) await moved;
    }
    return taskDto(getDbTask(taskId));
  }

  async function attachTaskToThread(taskId: string, thread: ThreadAttachmentTarget) {
    const task = getDbTask(taskId);
    const project = await resolveProject(task);
    if (project.id !== thread.projectId) {
      throw new Error(`Task ${taskDto(task).identifier} belongs to ${project.name}, not this thread's project`);
    }
    return persistTaskAttachment(taskId, thread);
  }
  async function threadBranchName(environmentId: string | null) {
    if (!environmentId) return null;
    try {
      return (await bb.sdk.environments.get({ environmentId })).branchName ?? null;
    } catch {
      return null;
    }
  }

  async function bindingCandidates(thread: ThreadAttachmentTarget & { title?: string | null }) {
    const declined = new Set((db.prepare("SELECT task_id FROM declined_thread_task WHERE thread_id = ?").all(thread.id) as Array<{ task_id: string }>)
      .map((row) => row.task_id));
    const [projectTasks, branchName] = await Promise.all([
      tasksForProject(thread.projectId),
      threadBranchName(thread.environmentId),
    ]);
    const tasks = projectTasks.filter((task) => !task.threadIds.includes(thread.id) && !declined.has(task.id));
    return {
      tasks,
      texts: [thread.title ?? "", branchName ?? ""],
    };
  }

  async function threadTaskState(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    const attachedTasks = threadTasks(threadId).map(taskDto);
    if (attachedTasks.length) return { projectId: thread.projectId, attached: attachedTasks[0]!, attachedTasks, suggested: null };
    if (thread.parentThreadId) return { projectId: thread.projectId, attached: null, attachedTasks, suggested: null };
    const { tasks, texts } = await bindingCandidates(thread);
    const exact = exactTaskMatch(tasks, texts);
    const suggested = exact ?? suggestTaskByTitle(thread.title, tasks);
    return { projectId: thread.projectId, attached: null, attachedTasks, suggested };
  }

  async function attachDeterministicTask(thread: ThreadAttachmentTarget & { title?: string | null }) {
    if (threadHasTask(thread.id)) return;
    const { tasks, texts } = await bindingCandidates(thread);
    const match = exactTaskMatch(tasks, texts);
    if (match) await attachTaskToThread(match.id, thread);
  }

  function declineThreadTask(threadId: string, taskId: string) {
    db.prepare(`INSERT INTO declined_thread_task (thread_id, task_id, declined_at) VALUES (?, ?, ?)
      ON CONFLICT(thread_id, task_id) DO UPDATE SET declined_at = excluded.declined_at`).run(threadId, taskId, now());
    bb.realtime.publish("tasks-changed", { reason: "suggestion-declined", taskId });
    return { ok: true as const };
  }

  function detachTaskThread(threadId: string, taskId?: string) {
    const tasks = threadTasks(threadId).filter((task) => !taskId || task.id === taskId);
    if (!tasks.length) throw new Error("This thread is not attached to that task");
    const decline = db.prepare(`INSERT INTO declined_thread_task (thread_id, task_id, declined_at) VALUES (?, ?, ?)
      ON CONFLICT(thread_id, task_id) DO UPDATE SET declined_at = excluded.declined_at`);
    const unlink = db.prepare("DELETE FROM task_threads WHERE thread_id = ? AND task_id = ?");
    const touch = db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?");
    db.transaction(() => tasks.forEach((task) => {
      decline.run(threadId, task.id, now());
      unlink.run(threadId, task.id);
      touch.run(now(), task.id);
    }))();
    for (const task of tasks) bb.realtime.publish("tasks-changed", { reason: "chat-detached", taskId: task.id });
    return taskDto(getDbTask(tasks[0]!.id));
  }

  function initialTaskMention(rows: unknown) {
    const conversations: Array<{ sequence: number; mentions: unknown[] }> = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const row = jsonRecord(value);
      if (!Object.keys(row).length) return;
      if (row.kind === "conversation" && row.role === "user" && row.initiator === "user" && Array.isArray(row.mentions)) {
        conversations.push({
          sequence: typeof row.sourceSeqStart === "number" ? row.sourceSeqStart : Number.MAX_SAFE_INTEGER,
          mentions: row.mentions,
        });
      }
      if (Array.isArray(row.children)) visit(row.children);
    };
    visit(rows);
    const initial = conversations.sort((left, right) => left.sequence - right.sequence)[0];
    if (!initial) return { ready: false, taskId: null };
    for (const value of initial.mentions) {
      const resource = jsonRecord(jsonRecord(value).resource);
      if (resource.kind !== "plugin" || resource.pluginId !== bb.pluginId || typeof resource.itemId !== "string") continue;
      if (resource.itemId.startsWith("task:")) {
        return { ready: true, taskId: resource.itemId.slice("task:".length) };
      }
    }
    return { ready: true, taskId: null };
  }

  const inspectedInitialTaskThreads = new Set<string>();
  async function attachInitialTaskMention(thread: ThreadAttachmentTarget): Promise<"pending" | "attached" | "none"> {
    if (inspectedInitialTaskThreads.has(thread.id)) {
      return threadHasTask(thread.id) ? "attached" : "none";
    }
    if (threadHasTask(thread.id)) {
      inspectedInitialTaskThreads.add(thread.id);
      return "attached";
    }
    const timeline = await bb.sdk.threads.timeline({ threadId: thread.id });
    const { ready, taskId } = initialTaskMention(timeline.rows);
    if (!ready) return "pending";
    if (!taskId || !db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND EXISTS
      (SELECT 1 FROM task_refs WHERE task_refs.task_id = tasks.id)`).get(taskId)) {
      inspectedInitialTaskThreads.add(thread.id);
      return "none";
    }
    if (db.prepare("SELECT 1 FROM declined_thread_task WHERE thread_id = ? AND task_id = ?").get(thread.id, taskId)) {
      inspectedInitialTaskThreads.add(thread.id);
      return "none";
    }
    await attachTaskToThread(taskId, thread);
    inspectedInitialTaskThreads.add(thread.id);
    return "attached";
  }

  async function attachChat(taskId: string, fresh = false) {
    const task = getDbTask(taskId);
    const project = await resolveProject(task);
    const projectId = project.id;
    const newest = fresh ? undefined : taskThreads(taskId)[0];
    let threadId = newest?.thread_id ?? null;
    let environmentId = newest?.environment_id ?? null;
    if (threadId) {
      await bb.sdk.threads.unarchive({ threadId }).catch(() => undefined);
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: `Resume work on this task.\n\n${taskPrompt(task)}`, mentions: [] }],
      });
    } else {
      const environment: { type: "host"; workspace: { type: "personal" } } | { type: "project-default" } = project.kind === "personal"
        ? { type: "host" as const, workspace: { type: "personal" as const } }
        : { type: "project-default" as const };
      const thread = await bb.sdk.threads.spawn({ projectId, environment, title: task.title, prompt: taskPrompt(task) });
      threadId = thread.id;
      environmentId = thread.environmentId;
    }
    return await persistTaskAttachment(taskId, {
      id: threadId,
      projectId,
      environmentId,
      startedByTask: !newest,
    });
  }


  // A task can join any number of chats, so another chat never blocks it.
  // attachedThreadId is set only when the task is already on this chat.
  function listAttachmentCandidates(threadId: string, query: string) {
    const needle = query.trim().toLowerCase();
    return {
      tasks: listTasks()
        .filter((task) => !needle || taskSearchValues(task)
          .some((value) => value.toLowerCase().includes(needle)))
        .slice(0, 100)
        .map((task) => ({
          id: task.id,
          identifier: task.identifier,
          title: task.title,
          status: task.status,
          attachedThreadId: task.threadIds.includes(threadId) ? threadId : null,
          attachedToCurrentThread: task.threadIds.includes(threadId),
        })),
    };
  }

  async function attachExistingChat(taskId: string, threadId: string, startedByTask = false) {
    const thread = await topLevelThread(threadId);
    return await persistTaskAttachment(taskId, { ...thread, startedByTask });
  }

  // Only top-level threads join tasks. A child thread is part of its parent's work.
  async function topLevelThread(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.parentThreadId) throw new Error("Only a top-level thread can join a task");
    return thread;
  }

  // Create a thread from the composer request and attach it to the task. The composer's own
  // environment decides where it runs, this machine or a cloud sandbox.
  async function startTaskThread(taskId: string, request: NewThreadRequest) {
    // Source mappings provide the initial project suggestion, but an explicit
    // project selected in the composer is the execution context.
    const task = getDbTask(taskId);
    // The first turn can start before the task is linked, so the task's instructions go
    // first, seen only by the agent.
    request = {
      ...request,
      input: [
        { type: "text", text: taskAgentContext(task, attachedTaskStage(task.status)), mentions: [], visibility: "agent-only" },
        ...request.input,
      ],
    };
    const thread = await bb.sdk.threads.spawn({ ...request, title: task.title });
    // The chat opens at once. Moving the task to doing writes to its provider, which is slow.
    return { threadId: thread.id, task: await persistTaskAttachment(taskId, { ...thread, startedByTask: true }, { awaitStage: false }) };
  }

  function githubIssueRef(ref: DbRef) {
    const metadata = jsonRecord(JSON.parse(ref.metadata));
    if (typeof metadata.ownerRepo !== "string" || typeof metadata.number !== "number") return null;
    return { ownerRepo: metadata.ownerRepo, number: metadata.number };
  }

  async function githubIssueLabels(issue: { ownerRepo: string; number: number }, token: string) {
    const raw = jsonRecord(await fetchGithubJson(
      `https://api.github.com/repos/${issue.ownerRepo}/issues/${issue.number}`, { headers: githubHeaders(token) }));
    return Array.isArray(raw.labels)
      ? raw.labels.map((label) => typeof label === "string" ? label : String(jsonRecord(label).name ?? "")).filter(Boolean)
      : [];
  }

  async function putGithubLabels(issue: { ownerRepo: string; number: number }, token: string, labels: string[]) {
    // GitHub auto-creates any label that does not yet exist in the repository.
    await fetchGithubJson(`https://api.github.com/repos/${issue.ownerRepo}/issues/${issue.number}/labels`, {
      method: "PUT",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ labels }),
    });
  }

  async function setGithubIssueState(issue: { ownerRepo: string; number: number }, token: string,
    state: "open" | "closed", reason?: "completed" | "not_planned") {
    await fetchGithubJson(`https://api.github.com/repos/${issue.ownerRepo}/issues/${issue.number}`, {
      method: "PATCH",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ state, ...(reason ? { state_reason: reason } : {}) }),
    });
  }

  async function writeGithubStage(ref: DbRef, status: Status, token: string) {
    const issue = githubIssueRef(ref);
    if (!issue) return;
    if (status === "done" || status === "cancelled") {
      await setGithubIssueState(issue, token, "closed", status === "done" ? "completed" : "not_planned");
      return;
    }
    const labels = (await githubIssueLabels(issue, token)).filter((name) => !name.startsWith(STAGE_LABEL_PREFIX));
    await putGithubLabels(issue, token, [...labels, `${STAGE_LABEL_PREFIX}${status}`]);
    await setGithubIssueState(issue, token, "open");
  }

  async function writeGithubPriority(ref: DbRef, priority: Priority | null, token: string) {
    const issue = githubIssueRef(ref);
    if (!issue) return;
    const labels = (await githubIssueLabels(issue, token)).filter((name) => !name.startsWith(PRIORITY_LABEL_PREFIX));
    await putGithubLabels(issue, token, priority ? [...labels, `${PRIORITY_LABEL_PREFIX}${priority}`] : labels);
  }

  async function setLinearStage(ref: DbRef, status: Status, token: string) {
    const stateType = linearStateTypeByStatus[status];
    const data = await linearGraphql(token, `query WorkflowStateForStatus($id: String!) {
      issue(id: $id) { team { states { nodes { id type name } } } }
    }`, { id: ref.external_id });
    const nodes = jsonRecord(jsonRecord(jsonRecord(data.issue).team).states).nodes;
    const state = Array.isArray(nodes) ? nodes.map(jsonRecord).find((candidate) => candidate.type === stateType) : undefined;
    if (!state?.id) throw new Error(`No Linear ${stateType} state found for ${ref.title}`);
    const update = await linearGraphql(token, `mutation UpdateIssueState($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`, { id: ref.external_id, stateId: state.id });
    requireLinearIssueUpdate(update, `move ${ref.title}`);
  }

  async function syncLinearStage(taskId: string, status: Status) {
    const refs = refsFor(taskId).filter((ref) => ref.provider === "linear");
    if (!refs.length) return;
    const token = (await settings.get()).linearToken;
    if (!token) throw new Error("Configure Linear before changing a Linear task stage");
    await Promise.all(refs.map((ref) => setLinearStage(ref, status, token)));
  }


  // A task's only open chat carries the task's title. A task with several open chats leaves their titles alone,
  // and so does a chat shared with another task.
  async function syncChatTitles(taskId: string, threadId?: string) {
    try {
      const open = (await linkedThreads(taskThreads(taskId))).filter((thread) => thread.archivedAt === null);
      const chat = open.length === 1 ? open[0]! : null;
      if (!chat || (threadId && chat.id !== threadId) || threadTasks(chat.id).length > 1) return;
      await bb.sdk.threads.update({ threadId: chat.id, title: getDbTask(taskId).title });
    } catch (error) {
      bb.log.warn(`Could not rename the chat of task ${taskId}: ${errorMessage(error)}`);
    }
  }

  // Writes a new title to every linked source first, so the next sync keeps it.
  async function renameTask(taskId: string, title: string) {
    getDbTask(taskId);
    const current = await settings.get();
    const refs = refsFor(taskId);
    await Promise.all(refs.map(async (ref) => {
      if (ref.provider === "linear") {
        if (!current.linearToken) throw new Error("Configure Linear before renaming a Linear task");
        const update = await linearGraphql(current.linearToken, `mutation RenameIssue($id: String!, $title: String!) {
          issueUpdate(id: $id, input: { title: $title }) { success }
        }`, { id: ref.external_id, title });
        requireLinearIssueUpdate(update, `rename ${ref.title}`);
      } else if (ref.provider === "akiflow") {
        if (!current.akiflowRefreshToken) throw new Error("Configure Akiflow before renaming an Akiflow task");
        await akiflowPatch(ref, { title });
      } else if (ref.provider === "github") {
        const issue = githubIssueRef(ref);
        if (!issue) return;
        if (!current.githubToken) throw new Error("Configure GitHub before renaming a GitHub task");
        await fetchGithubJson(`https://api.github.com/repos/${issue.ownerRepo}/issues/${issue.number}`, {
          method: "PATCH",
          headers: { ...githubHeaders(current.githubToken), "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
      }
    }));
    const timestamp = now();
    db.transaction(() => {
      db.prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?").run(title, timestamp, taskId);
      db.prepare("UPDATE task_refs SET title = ?, updated_at = ? WHERE task_id = ?").run(title, timestamp, taskId);
    })();
    await syncChatTitles(taskId);
    bb.realtime.publish("tasks-changed", { reason: "content", taskId });
    return taskDto(getDbTask(taskId));
  }

  async function akiflowPatch(ref: DbRef, fields: JsonObject) {
    const token = await akiflowAccessToken();
    await fetchJson(AKIFLOW_TASKS, {
      method: "PATCH",
      headers: akiflowHeaders(token),
      body: JSON.stringify([{ id: ref.external_id, global_updated_at: now(), ...fields }]),
    }, "Akiflow", true);
  }

  async function completeAkiflow(ref: DbRef) {
    await akiflowPatch(ref, { done: true, done_at: now() });
  }

  async function trashAkiflow(ref: DbRef) {
    await akiflowPatch(ref, { trashed_at: now() });
  }

  async function setAkiflowPriority(ref: DbRef, priority: Priority | null) {
    await akiflowPatch(ref, { priority: priority ? akiflowPriorityValues[priority] : 0 });
  }

  // Create the `stage:<x>` tag if it does not exist yet, returning its id. Akiflow's private
  // v5 API has no documented tag-create contract, so we clone the exact field shape of a real
  // existing tag (overriding id/title/timestamps) to guarantee a schema Akiflow accepts. The
  // /v5/tags endpoint upserts an array the same way /v5/tasks does.
  async function ensureAkiflowStageTag(status: Status, token: string, tags: JsonObject[]) {
    const existing = tags.find((tag) => !tag.deleted_at && tag.title === `${STAGE_LABEL_PREFIX}${status}`);
    if (existing?.id) return String(existing.id);
    const id = randomUUID();
    const timestamp = now();
    const template = tags.find((tag) => tag.id && typeof tag.title === "string");
    const tag: JsonObject = {
      ...(template ?? {}),
      id,
      title: `${STAGE_LABEL_PREFIX}${status}`,
      deleted_at: null,
      trashed_at: null,
      created_at: timestamp,
      updated_at: timestamp,
      global_created_at: timestamp,
      global_updated_at: timestamp,
    };
    await fetchJson(AKIFLOW_TAGS, { method: "PATCH", headers: akiflowHeaders(token), body: JSON.stringify([tag]) }, "Akiflow", true);
    return id;
  }

  // Akiflow has no workflow columns, so an open stage is represented by a `stage:<x>` tag,
  // created on demand if it does not exist yet.
  async function writeAkiflowStage(ref: DbRef, status: Status) {
    const token = await akiflowAccessToken();
    const tags = await akiflowSync(AKIFLOW_TAGS, token);
    const stageTagIds = new Set(tags
      .filter((tag) => !tag.deleted_at && typeof tag.title === "string" && tag.title.startsWith(STAGE_LABEL_PREFIX))
      .map((tag) => String(tag.id)));
    const targetId = await ensureAkiflowStageTag(status, token, tags);
    const metadata = jsonRecord(JSON.parse(ref.metadata));
    const kept = (Array.isArray(metadata.tagIds) ? metadata.tagIds.map(String) : [])
      .filter((id) => !stageTagIds.has(id));
    await akiflowPatch(ref, { tags_ids: [...kept, targetId], done: false, done_at: null, trashed_at: null });
  }

  // Proactively create every open-stage tag so the Akiflow side is ready before any move.
  async function ensureAkiflowStageTags() {
    const token = await akiflowAccessToken();
    const tags = await akiflowSync(AKIFLOW_TAGS, token);
    const created: string[] = [];
    for (const status of statuses) {
      if (status === "done" || status === "cancelled") continue;
      const before = tags.some((tag) => !tag.deleted_at && tag.title === `${STAGE_LABEL_PREFIX}${status}`);
      const id = await ensureAkiflowStageTag(status, token, tags);
      if (!before) { created.push(`${STAGE_LABEL_PREFIX}${status}`); tags.push({ id, title: `${STAGE_LABEL_PREFIX}${status}` }); }
    }
    return { created };
  }

  async function setLinearPriority(ref: DbRef, priority: Priority | null, token: string) {
    const update = await linearGraphql(token, `mutation SetPriority($id: String!, $priority: Int!) {
      issueUpdate(id: $id, input: { priority: $priority }) { success }
    }`, { id: ref.external_id, priority: priority ? linearPriorityValues[priority] : 0 });
    requireLinearIssueUpdate(update, `set priority for ${ref.title}`);
  }

  // Priority lives in each ref's metadata (native int for Linear/Akiflow, normalized
  // string for GitHub) and is derived by taskDto; refresh it after a write-back so the
  // board reflects the change without waiting for the next sync.
  function updateRefPriorityMetadata(ref: DbRef, value: number | string | null) {
    const metadata = jsonRecord(JSON.parse(ref.metadata));
    metadata.priority = value;
    db.prepare("UPDATE task_refs SET metadata = ?, updated_at = ? WHERE provider = ? AND external_id = ?")
      .run(JSON.stringify(metadata), now(), ref.provider, ref.external_id);
  }

  async function setPriority(taskId: string, priority: Priority | null) {
    getDbTask(taskId);
    const current = await settings.get();
    const refs = refsFor(taskId);
    await Promise.all(refs.map(async (ref) => {
      if (ref.provider === "linear") {
        if (!current.linearToken) throw new Error("Configure Linear before changing a Linear task priority");
        await setLinearPriority(ref, priority, current.linearToken);
        updateRefPriorityMetadata(ref, priority ? linearPriorityValues[priority] : 0);
      } else if (ref.provider === "akiflow") {
        if (!current.akiflowRefreshToken) throw new Error("Configure Akiflow before changing an Akiflow task priority");
        await setAkiflowPriority(ref, priority);
        updateRefPriorityMetadata(ref, priority ? akiflowPriorityValues[priority] : 0);
      } else if (ref.provider === "github") {
        if (!current.githubToken) throw new Error("Configure GitHub before changing a GitHub task priority");
        await writeGithubPriority(ref, priority, current.githubToken);
        updateRefPriorityMetadata(ref, priority);
      }
    }));
    // A task that changes priority leaves its old place in Now or Later.
    db.prepare("UPDATE tasks SET list_position = NULL WHERE id = ?").run(taskId);
    bb.realtime.publish("tasks-changed", { reason: "priority", taskId });
    return taskDto(getDbTask(taskId));
  }

  // Now and Later keep a local order. Tasks that arrive from another priority are moved first.
  async function arrangeTasks(priority: "urgent" | "high", taskIds: string[]) {
    for (const taskId of taskIds) {
      if (taskPriority(taskDto(getDbTask(taskId))) !== priority) await setPriority(taskId, priority);
    }
    const update = db.prepare("UPDATE tasks SET list_position = ? WHERE id = ?");
    db.transaction(() => taskIds.forEach((taskId, position) => update.run(position, taskId)))();
    bb.realtime.publish("tasks-changed", { reason: "arrange", priority });
    return { arranged: taskIds.length };
  }

  // Terminal stages: done and cancelled. Both write completion to every linked source
  // (Linear completed/canceled state, GitHub close-reason, Akiflow done/trash) and archive
  // the task's chats and environments. A chat or environment shared with an open task stays.
  async function archiveTaskWorkspace(taskId: string) {
    const links = db.prepare(`SELECT * FROM task_threads AS link WHERE task_id = ? AND NOT EXISTS
      (SELECT 1 FROM task_threads AS other JOIN tasks ON tasks.id = other.task_id
        WHERE (other.thread_id = link.thread_id OR other.environment_id = link.environment_id)
          AND tasks.status NOT IN ('done', 'cancelled'))`).all(taskId) as TaskThread[];
    const archivedEnvironments = new Set<string>();
    for (const link of links) {
      try {
        if (link.environment_id) {
          if (archivedEnvironments.has(link.environment_id)) continue;
          const environment = await bb.sdk.environments.get({ environmentId: link.environment_id }).catch(() => null);
          if (environment?.workspaceProvisionType === "managed-worktree") {
            await bb.sdk.environments.archiveThreads({ environmentId: link.environment_id });
            archivedEnvironments.add(link.environment_id);
            continue;
          }
        }
        await bb.sdk.threads.archive({ threadId: link.thread_id });
      } catch (error) {
        bb.log.warn(`Task completed, but its attached workspace could not be archived: ${errorMessage(error)}`);
      }
    }
  }

  async function finalizeTask(taskId: string, status: "done" | "cancelled") {
    getDbTask(taskId);
    const current = await settings.get();
    const refs = refsFor(taskId);
    const linearRefs = refs.filter((ref) => ref.provider === "linear");
    if (linearRefs.length) {
      if (!current.linearToken) throw new Error(`Configure Linear before marking a Linear task ${status}`);
      await Promise.all(linearRefs.map((ref) => setLinearStage(ref, status, current.linearToken!)));
    }
    const writes = refs.filter((ref) => ref.provider !== "linear").map(async (ref) => {
      if (ref.provider === "github" && current.githubToken) await writeGithubStage(ref, status, current.githubToken);
      if (ref.provider === "akiflow" && current.akiflowRefreshToken) {
        if (status === "done") await completeAkiflow(ref);
        else await trashAkiflow(ref);
      }
    });
    const results = await Promise.allSettled(writes);
    for (const result of results) if (result.status === "rejected") bb.log.warn(`${status} write-back failed: ${errorMessage(result.reason)}`);
    // Commit the terminal status before archiving. archiveTaskWorkspace never throws,
    // and writing first means the thread.archived listener below already sees a terminal
    // task — otherwise our own archive would prompt "mark this done?" for a task we just
    // marked done, once per thread in a cascade-archived environment.
    db.prepare(`UPDATE tasks SET status = ?, merge_pending = 0, sort_order = ?, updated_at = ? WHERE id = ?`)
      .run(status, nextSortOrder(status), now(), taskId);
    db.prepare("DELETE FROM archive_task_prompts WHERE task_id = ?").run(taskId);
    await archiveTaskWorkspace(taskId);
    bb.realtime.publish("tasks-changed", { reason: status, taskId });
    return taskDto(getDbTask(taskId));
  }

  // Retained for existing callers (PR merge → done).
  async function completeTask(taskId: string) {
    return finalizeTask(taskId, "done");
  }

  async function setStatus(taskId: string, status: Status) {
    if (status === "done" || status === "cancelled") return finalizeTask(taskId, status);
    getDbTask(taskId);
    const current = await settings.get();
    const refs = refsFor(taskId);
    // Linear is authoritative and blocking; GitHub/Akiflow write-backs are best-effort so a
    // single provider outage never blocks a board move.
    const linearRefs = refs.filter((ref) => ref.provider === "linear");
    if (linearRefs.length) {
      if (!current.linearToken) throw new Error("Configure Linear before changing a Linear task stage");
      await Promise.all(linearRefs.map((ref) => setLinearStage(ref, status, current.linearToken!)));
    }
    const writes = refs.filter((ref) => ref.provider !== "linear").map(async (ref) => {
      if (ref.provider === "github" && current.githubToken) await writeGithubStage(ref, status, current.githubToken);
      if (ref.provider === "akiflow" && current.akiflowRefreshToken) await writeAkiflowStage(ref, status);
    });
    const results = await Promise.allSettled(writes);
    for (const result of results) if (result.status === "rejected") bb.log.warn(`stage write-back failed: ${errorMessage(result.reason)}`);
    db.prepare("UPDATE tasks SET status = ?, merge_pending = 0, sort_order = ?, updated_at = ? WHERE id = ?")
      .run(status, nextSortOrder(status), now(), taskId);
    bb.realtime.publish("tasks-changed", { reason: "status", taskId });
    return taskDto(getDbTask(taskId));
  }

  async function projectsWith(projectId: string) {
    const projects = await availableProjects();
    if (!projects.some((project) => project.id === projectId)) throw new Error("That bb project no longer exists");
    return projects;
  }

  // A task's own project_id overrides its source mapping. It stays empty when the sources already lead there.
  function placeInProject(taskId: string, projectId: string, projects: ProjectInfo[]) {
    const home = effectiveProjectId({ ...getDbTask(taskId), project_id: null }, projects);
    db.prepare("UPDATE tasks SET project_id = ?, updated_at = ? WHERE id = ?").run(home === projectId ? null : projectId, now(), taskId);
  }

  // A move goes through the provider when it can, so the next sync agrees with it.
  // An Akiflow or Linear task moves inside its provider. Any other task is remade in the new
  // project's provider. A project with no destination, or a task with several sources, keeps
  // a local override.
  async function setProject(taskId: string, projectId: string) {
    const task = getDbTask(taskId);
    const projects = await projectsWith(projectId);
    const refs = refsFor(taskId);
    const open = task.status !== "done" && task.status !== "cancelled";
    let leftover: string | null = null;
    if (open && refs.length === 1 && effectiveProjectId({ ...task, project_id: null }, projects) !== projectId) {
      const ref = refs[0]!;
      const destination = await moveDestination(ref, projectId, projects);
      if (destination?.provider === ref.provider && ref.provider !== "github") await moveInProvider(ref, destination.id, destination.label);
      else if (destination) leftover = await remake(task, ref, destination);
    }
    placeInProject(taskId, projectId, projects);
    bb.realtime.publish("tasks-changed", { reason: "project", taskId });
    if (leftover) throw new Error(leftover);
    return taskDto(getDbTask(taskId));
  }

  // The project's destination that its open tasks use most. The task's own provider comes
  // first, so an Akiflow or Linear task can move without being remade.
  async function moveDestination(ref: DbRef, projectId: string, projects: ProjectInfo[]) {
    const options = (await createTaskOptions()).providers.flatMap((entry) => {
      if (entry.provider === ref.provider && entry.error) throw new Error(entry.error);
      return entry.destinations.filter((destination) => destination.projectId === projectId)
        .map((destination) => ({ provider: entry.provider, id: destination.id, label: destination.label }));
    });
    const used = new Map<string, number>();
    for (const task of taskRows()) {
      if (task.status === "done" || task.status === "cancelled" || effectiveProjectId(task, projects) !== projectId) continue;
      for (const other of refsFor(task.id)) {
        const key = sourceScope(other)?.key ?? `${other.provider}:inbox`;
        used.set(key, (used.get(key) ?? 0) + 1);
      }
    }
    const uses = (id: string) => used.get(id.startsWith("github:") ? id.toLowerCase() : id.split(":team:")[0]!) ?? 0;
    const native = ref.provider !== "github" && options.some((option) => option.provider === ref.provider);
    return options.filter((option) => !native || option.provider === ref.provider)
      .sort((left, right) => uses(right.id) - uses(left.id))[0] ?? null;
  }

  async function moveInProvider(ref: DbRef, destinationId: string, label: string) {
    if (ref.provider === "akiflow") {
      const listId = destinationId.startsWith("akiflow:project:") ? destinationId.slice("akiflow:project:".length) : null;
      await akiflowPatch(ref, { listId, global_list_id_updated_at: now() });
      const { sourceKey: _key, sourceLabel: _label, ...metadata } = jsonRecord(JSON.parse(ref.metadata));
      db.prepare("UPDATE task_refs SET metadata = ?, updated_at = ? WHERE provider = 'akiflow' AND external_id = ?").run(JSON.stringify({
        ...metadata,
        ...(listId ? { sourceKey: destinationId, sourceLabel: `Akiflow · ${label}` } : {}),
        projectPath: listId ? label : null,
      }), now(), ref.external_id);
      return;
    }
    const token = (await settings.get()).linearToken;
    if (!token) throw new Error("Configure Linear before moving a Linear task");
    const [, projectId = null, teamId] = destinationId.match(/^linear:(?:project:([^:]+):team:|team:)([^:]+)$/) ?? [];
    if (!teamId) throw new Error("Choose a current Linear team or project");
    // Workflow states belong to a team, so a move to another team keeps the same kind of state.
    const target = await linearGraphql(token, `query MoveTarget($id: String!, $teamId: String!) {
      issue(id: $id) { team { id } state { type } }
      team(id: $teamId) { states { nodes { id type } } }
    }`, { id: ref.external_id, teamId });
    const issue = jsonRecord(target.issue);
    const states = jsonRecord(jsonRecord(target.team).states).nodes;
    const state = Array.isArray(states)
      ? states.map(jsonRecord).find((candidate) => candidate.type === jsonRecord(issue.state).type)
      : undefined;
    const input = jsonRecord(issue.team).id === teamId
      ? { projectId }
      : { projectId, teamId, ...(typeof state?.id === "string" ? { stateId: state.id } : {}) };
    const update = await linearGraphql(token, `mutation MoveIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { ...TaskFields } }
    }
    ${LINEAR_TASK_FIELDS}`, { id: ref.external_id, input });
    requireLinearIssueUpdate(update, `move ${ref.title}`);
    upsertExternal(linearExternalTask(jsonRecord(update.issueUpdate).issue));
  }

  // The new item joins the same bb task, so its chats and its place in Now or Later stay.
  // The old item is retired where it can be restored: Akiflow trash, a Linear cancel, a GitHub close.
  // A failed retire returns a message, because the move itself has already happened.
  async function remake(task: DbTask, ref: DbRef, destination: { provider: Provider; id: string; label: string }) {
    const dto = taskDto(task);
    const item = await createExternal({
      provider: destination.provider,
      destinationId: destination.id,
      title: dto.title,
      description: task.description,
      priority: taskPriority(dto),
      ownerId: destination.provider === "linear" ? currentOwnerId() : null,
    });
    if (item.provider === "akiflow") akiflowIdentifier(item.externalId, true);
    const timestamp = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO task_refs (task_id, provider, external_id, title, url, metadata, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(task.id, item.provider, item.externalId, item.title, item.url, refMetadata(item), timestamp);
      db.prepare("DELETE FROM task_refs WHERE provider = ? AND external_id = ?").run(ref.provider, ref.external_id);
      db.prepare("UPDATE tasks SET owner_id = ?, owner_source = ?, updated_at = ? WHERE id = ?")
        .run(item.ownerId !== undefined ? item.ownerId : task.owner_id, item.ownerId !== undefined ? "linear" : "local", timestamp, task.id);
    })();
    const current = await settings.get();
    const created = refsFor(task.id).find((other) => other.external_id === item.externalId)!;
    if (task.status !== (item.status ?? "triage")) {
      try {
        if (created.provider === "linear") await setLinearStage(created, task.status, current.linearToken!);
        else if (created.provider === "github") await writeGithubStage(created, task.status, current.githubToken!);
        else await writeAkiflowStage(created, task.status);
      } catch (error) {
        bb.log.warn(`stage write-back failed: ${errorMessage(error)}`);
      }
    }
    const note = `Moved to ${item.url ?? `Akiflow · ${destination.label}`}`;
    try {
      if (ref.provider === "akiflow") {
        await trashAkiflow(ref);
      } else if (ref.provider === "linear") {
        if (!current.linearToken) throw new Error("Linear is not configured");
        const comment = await linearGraphql(current.linearToken, `mutation MovedNote($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success }
        }`, { issueId: ref.external_id, body: note });
        if (jsonRecord(comment.commentCreate).success !== true) throw new Error("Linear did not add the note");
        await setLinearStage(ref, "cancelled", current.linearToken);
      } else {
        const issue = githubIssueRef(ref);
        if (!current.githubToken) throw new Error("GitHub is not configured");
        if (!issue) throw new Error("the issue number is unknown");
        await fetchGithubJson(`https://api.github.com/repos/${issue.ownerRepo}/issues/${issue.number}/comments`, {
          method: "POST",
          headers: { ...githubHeaders(current.githubToken), "Content-Type": "application/json" },
          body: JSON.stringify({ body: note }),
        });
        await setGithubIssueState(issue, current.githubToken, "closed", "not_planned");
      }
      return null;
    } catch (error) {
      return `Moved to ${destination.label}, but the old ${ref.provider} item is still open: ${errorMessage(error)}`;
    }
  }

  async function setOwner(taskId: string, ownerId: string | null) {
    getDbTask(taskId);
    if (ownerId && !db.prepare("SELECT 1 FROM owners WHERE id = ? AND active = 1").get(ownerId)) {
      throw new Error("Choose an active Linear workspace member");
    }
    const linearRefs = refsFor(taskId).filter((ref) => ref.provider === "linear");
    if (linearRefs.length) {
      const token = (await settings.get()).linearToken;
      if (!token) throw new Error("Configure Linear before changing a Linear task owner");
      await Promise.all(linearRefs.map(async (ref) => {
        const update = await linearGraphql(token, `mutation AssignIssue($id: String!, $assigneeId: String) {
          issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
        }`, { id: ref.external_id, assigneeId: ownerId });
        requireLinearIssueUpdate(update, `change the owner of ${ref.title}`);
      }));
    }
    db.prepare("UPDATE tasks SET owner_id = ?, owner_source = ?, updated_at = ? WHERE id = ?")
      .run(ownerId, linearRefs.length ? "linear" : "local", now(), taskId);
    bb.realtime.publish("tasks-changed", { reason: "owner", taskId });
    return taskDto(getDbTask(taskId));
  }

  async function answerMerged(taskId: string, decision: "done" | "keep") {
    if (decision === "done") return completeTask(taskId);
    getDbTask(taskId);
    let prUrl: string | null = null;
    for (const environmentId of new Set(taskThreads(taskId).map((link) => link.environment_id).filter((id) => id !== null))) {
      const result = await bb.sdk.environments.pullRequest({ environmentId });
      if (result.outcome !== "available") continue;
      prUrl ??= result.pullRequest.url;
      if (result.pullRequest.state === "merged") { prUrl = result.pullRequest.url; break; }
    }
    await syncLinearStage(taskId, "doing");
    db.prepare(`UPDATE tasks SET status = 'doing', merge_pending = 0,
      dismissed_pr_url = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
      .run(prUrl, nextSortOrder("doing"), now(), taskId);
    bb.realtime.publish("tasks-changed", { reason: "keep", taskId });
    return taskDto(getDbTask(taskId));
  }

  async function askAfterMerge(task: DbTask, threadId: string, prUrl: string) {
    const result = await bb.ui.requestInput({
      threadId,
      rendererId: "finish-task",
      title: "Pull request merged",
      payload: { taskId: task.id, title: task.title, prUrl },
      timeoutMs: 60 * 60 * 1000,
    });
    if (result.outcome !== "submitted") return;
    const decision = jsonRecord(result.value).decision;
    if (decision === "done" || decision === "keep") await answerMerged(task.id, decision);
  }

  // A thread reaching the end of its life is the strongest signal the work is over, so
  // offer the same terminal choices the merge prompt does. Declining records the thread id
  // so archiving it again (after an unarchive) never re-asks.
  async function answerArchived(taskId: string, decision: "done" | "cancelled" | "blocked" | "keep") {
    if (decision === "done" || decision === "cancelled") return finalizeTask(taskId, decision);
    const prompt = db.prepare("SELECT thread_id FROM archive_task_prompts WHERE task_id = ?").get(taskId) as { thread_id: string } | undefined;
    const archivedThreadId = prompt?.thread_id ?? taskThreads(taskId)[0]?.thread_id ?? null;
    if (decision === "blocked") {
      db.prepare("UPDATE tasks SET dismissed_archive_thread_id = ?, updated_at = ? WHERE id = ?")
        .run(archivedThreadId, now(), taskId);
      const updated = await setStatus(taskId, "blocked");
      db.prepare("DELETE FROM archive_task_prompts WHERE task_id = ?").run(taskId);
      return updated;
    }
    db.prepare("UPDATE tasks SET dismissed_archive_thread_id = ?, updated_at = ? WHERE id = ?")
      .run(archivedThreadId, now(), taskId);
    db.prepare("DELETE FROM archive_task_prompts WHERE task_id = ?").run(taskId);
    bb.realtime.publish("tasks-changed", { reason: "archive-dismissed", taskId });
    return taskDto(getDbTask(taskId));
  }

  function archivePrompt() {
    const task = db.prepare(`SELECT tasks.* FROM archive_task_prompts
      JOIN tasks ON tasks.id = archive_task_prompts.task_id
      WHERE tasks.status NOT IN ('done', 'cancelled')
      ORDER BY archive_task_prompts.created_at ASC
      LIMIT 1`).get() as DbTask | undefined;
    return task ? taskDto(task) : null;
  }

  function queueArchivePrompt(task: DbTask, threadId: string) {
    db.prepare(`INSERT INTO archive_task_prompts (task_id, thread_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET thread_id = excluded.thread_id, created_at = excluded.created_at`)
      .run(task.id, threadId, now());
    bb.realtime.publish("archive-task-prompt", { taskId: task.id });
  }

  // Deleted or unavailable threads are left out.
  async function linkedThreads(links: TaskThread[]) {
    const threads = await Promise.all(links
      .map((link) => bb.sdk.threads.get({ threadId: link.thread_id }).catch(() => null)));
    return threads.filter((thread) => thread !== null);
  }

  async function recoverRecentArchivePrompts() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const candidates = db.prepare(`SELECT * FROM tasks
      WHERE status NOT IN ('done', 'cancelled')
        AND EXISTS (SELECT 1 FROM task_threads WHERE task_id = tasks.id)
        AND id NOT IN (SELECT task_id FROM archive_task_prompts)`).all() as DbTask[];
    await Promise.all(candidates.map(async (task) => {
      const threads = await linkedThreads(taskThreads(task.id));
      if (!threads.length || threads.some((thread) => thread.archivedAt === null)) return;
      const last = threads.reduce((left, right) => left.archivedAt! >= right.archivedAt! ? left : right);
      if (last.archivedAt! >= cutoff && last.id !== task.dismissed_archive_thread_id) queueArchivePrompt(task, last.id);
    }));
  }

  async function checkPullRequests() {
    const links = db.prepare(`SELECT link.task_id, link.environment_id, MAX(link.thread_id) AS thread_id
      FROM task_threads AS link JOIN tasks ON tasks.id = link.task_id
      WHERE link.environment_id IS NOT NULL AND tasks.status IN ('doing', 'review')
      GROUP BY link.task_id, link.environment_id`).all() as Array<{ task_id: string; environment_id: string; thread_id: string }>;
    for (const link of links) {
      // An earlier environment of the same task may have changed it.
      const task = getDbTask(link.task_id);
      if (task.status !== "doing" && task.status !== "review") continue;
      try {
        const result = await bb.sdk.environments.pullRequest({ environmentId: link.environment_id });
        if (result.outcome !== "available") continue;
        const pr = result.pullRequest;
        if ((pr.state === "open" || pr.state === "draft") && task.status !== "review") {
          await syncLinearStage(task.id, "review").catch((error) => bb.log.warn(`Linear review sync failed for ${task.id}: ${errorMessage(error)}`));
          db.prepare("UPDATE tasks SET status = 'review', sort_order = ?, updated_at = ? WHERE id = ?")
            .run(nextSortOrder("review"), now(), task.id);
          bb.realtime.publish("tasks-changed", { reason: "review", taskId: task.id });
        }
        if (pr.state === "merged" && !task.merge_pending && task.dismissed_pr_url !== pr.url) {
          await syncLinearStage(task.id, "review").catch((error) => bb.log.warn(`Linear review sync failed for ${task.id}: ${errorMessage(error)}`));
          db.prepare("UPDATE tasks SET merge_pending = 1, status = 'review', sort_order = ?, updated_at = ? WHERE id = ?")
            .run(nextSortOrder("review"), now(), task.id);
          bb.realtime.publish("tasks-changed", { reason: "merged", taskId: task.id });
          void askAfterMerge(getDbTask(task.id), link.thread_id, pr.url).catch((error) => bb.log.warn(`Merge prompt failed: ${errorMessage(error)}`));
        }
      } catch (error) {
        bb.log.warn(`PR check failed for ${task.id}: ${errorMessage(error)}`);
      }
    }
  }

  // Child threads never join a task by themselves.
  bb.events.on("thread.active", async ({ thread }) => {
    if (thread.parentThreadId) return;
    const mention = await attachInitialTaskMention(thread).catch((error) => {
      bb.log.debug(`Initial task attachment will retry when the thread settles: ${errorMessage(error)}`);
      return "pending" as const;
    });
    if (mention === "none") await attachDeterministicTask(thread).catch((error) => {
      bb.log.debug(`Deterministic task attachment skipped for ${thread.id}: ${errorMessage(error)}`);
    });
  });
  bb.events.on("thread.idle", async ({ thread }) => {
    if (thread.parentThreadId) return;
    const mention = await attachInitialTaskMention(thread).catch((error) => {
      bb.log.warn(`Initial task attachment failed for ${thread.id}: ${errorMessage(error)}`);
      return "pending" as const;
    });
    if (mention === "none") await attachDeterministicTask(thread).catch((error) => {
      bb.log.debug(`Deterministic task attachment skipped for ${thread.id}: ${errorMessage(error)}`);
    });
  });
  // Fires for direct archives and for every thread in a cascade-archived environment.
  // Terminal tasks are skipped, which also covers the archive finalizeTask performs itself.
  // A task with another open chat is still being worked on, so it is not asked.
  bb.events.on("thread.archived", async ({ thread }) => {
    for (const task of threadTasks(thread.id)) {
      if (task.status === "done" || task.status === "cancelled") continue;
      if (task.dismissed_archive_thread_id === thread.id) continue;
      const others = taskThreads(task.id).filter((link) => link.thread_id !== thread.id);
      if (others.length && (await linkedThreads(others)).some((other) => other.archivedAt === null)) continue;
      queueArchivePrompt(task, thread.id);
    }
  });
  bb.events.on("thread.unarchived", ({ thread }) => {
    const removed = db.prepare("DELETE FROM archive_task_prompts WHERE thread_id = ?").run(thread.id);
    if (removed.changes) bb.realtime.publish("archive-task-prompt", { threadId: thread.id });
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    inspectedInitialTaskThreads.delete(thread.id);
    db.prepare("DELETE FROM declined_thread_task WHERE thread_id = ?").run(thread.id);
    if (db.prepare("DELETE FROM task_threads WHERE thread_id = ?").run(thread.id).changes) {
      bb.realtime.publish("tasks-changed", { reason: "chat-deleted", threadId: thread.id });
    }
  });
  void recoverRecentArchivePrompts().catch((error) => {
    bb.log.warn(`Recent archive prompt recovery failed: ${errorMessage(error)}`);
  });

  async function readTasks(input: z.infer<typeof readContract["read.list"]["input"]>) {
    const projects = await availableProjects();
    let tasks = taskRows().flatMap((row) => {
      const projectId = effectiveProjectId(row, projects);
      return input.projectId && projectId !== input.projectId ? []
        : [{ ...taskDto(row), effectiveProjectId: projectId }];
    });
    if (input.provider) tasks = tasks.filter((task) => task.refs.some((ref) => ref.provider === input.provider));
    if (input.status) tasks = tasks.filter((task) => task.status === input.status);
    if (input.priority) tasks = tasks.filter((task) => taskPriority(task) === (input.priority === "none" ? null : input.priority));
    const owner = input.owner;
    if (owner) {
      tasks = tasks.filter((task) => owner === "me" ? task.owner?.isMe
        : owner === "none" ? !task.owner
          : task.owner?.id === owner || task.owner?.name.toLowerCase() === owner.toLowerCase());
    }
    if (input.query.trim()) {
      const needle = input.query.toLowerCase();
      tasks = tasks.filter((task) => taskSearchValues(task).some((value) => value.toLowerCase().includes(needle)));
    }
    return { tasks: tasks.slice(input.offset, input.offset + input.limit),
      total: tasks.length, limit: input.limit, offset: input.offset,
      hasMore: input.offset + input.limit < tasks.length };
  }

  async function readTask(input: z.infer<typeof readContract["read.show"]["input"]>) {
    const task = input.projectId ? await taskForProject(input.identifier, input.projectId) : taskDto(findTask(input.identifier));
    const threads = taskThreads(task.id).map((link) => ({
      threadId: link.thread_id, environmentId: link.environment_id,
      attachedAt: link.attached_at, startedByTask: Boolean(link.started_by_task),
    }));
    const environmentIds = [...new Set(threads.map((thread) => thread.environmentId).filter((id): id is string => id !== null))];
    const results = await mapWithConcurrency(environmentIds, 4, async (environmentId) => {
      try {
        const result = await bb.sdk.environments.pullRequest({ environmentId });
        if (result.outcome === "absent") return { pullRequest: null, error: null };
        if (result.outcome === "unavailable") return { pullRequest: null, error: { environmentId, message: result.message } };
        const pr = result.pullRequest;
        return { pullRequest: {
          environmentId, url: pr.url, number: pr.number, title: pr.title, state: pr.state,
          updatedAt: pr.updatedAt, headRefName: pr.headRefName, baseRefName: pr.baseRefName,
          checkState: pr.checks.state, reviewState: pr.review.state, mergeability: pr.mergeability.state,
        }, error: null };
      } catch (error) {
        return { pullRequest: null, error: { environmentId, message: errorMessage(error) } };
      }
    });
    return {
      ...task, threads,
      pullRequests: results.flatMap((result) => result.pullRequest ? [result.pullRequest] : []),
      pullRequestErrors: results.flatMap((result) => result.error ? [result.error] : []),
    };
  }

  bb.rpc.register(readContract, {
    "read.list": readTasks,
    "read.show": readTask,
  }, { experimental_discoverable: true, experimental_description: "Read synced tasks, linked workspaces and backed PR state without mutations." });

  bb.rpc.register(rpcContract, {
    listTasks: async () => {
      const current = await settings.get();
      const enabled = enabledProviderSet();
      const projects = await availableProjects().catch(() => [] as ProjectInfo[]);
      return {
        tasks: taskRows().map((task) => ({ ...taskDto(task), effectiveProjectId: effectiveProjectId(task, projects) })),
        owners: owners(),
        akiflowConnected: enabled.has("akiflow") && Boolean(current.akiflowRefreshToken),
        enabledProviders: providers.filter((provider) => enabled.has(provider)),
      };
    },
    boardTasks,
    printNow,
    setStatus: ({ taskId, status }) => setStatus(taskId, status),
    threadTask: ({ threadId }) => threadTaskState(threadId),
    declineThreadTask: ({ threadId, taskId }) => declineThreadTask(threadId, taskId),
    detachTaskThread: ({ threadId, taskId }) => detachTaskThread(threadId, taskId),
    setPriority: ({ taskId, priority }) => setPriority(taskId, priority),
    renameTask: ({ taskId, title }) => renameTask(taskId, title),
    setProjectHidden: ({ projectId, hidden }) => setProjectHidden(projectId, hidden),
    attachChat: ({ taskId, fresh }) => attachChat(taskId, fresh),
    listAttachmentCandidates: ({ threadId, query }) => listAttachmentCandidates(threadId, query),
    attachExistingChat: ({ taskId, threadId }) => attachExistingChat(taskId, threadId),
    startTaskThread: ({ taskId, request }) => startTaskThread(taskId, request),
    answerArchived: ({ taskId, decision }) => answerArchived(taskId, decision),
    archivePrompt: () => archivePrompt(),
    projectMappings: async () => projectMappings(),
    setProjectMapping: ({ sourceKey, projectId }) => setProjectMapping(sourceKey, projectId),
    githubRepositories: async () => githubRepositoryState(),
    refreshGithubRepositories: async () => refreshGithubRepositories(),
    setGithubRepositoryEnabled: ({ fullName, enabled }) => setGithubRepositoryEnabled(fullName, enabled),
    linearSources: async () => linearSourceState(),
    refreshLinearSources: async () => refreshLinearSources(),
    setLinearSourceEnabled: ({ key, enabled }) => setLinearSourceEnabled(key, enabled),
    setAllLinearSourcesEnabled: ({ enabled }) => setAllLinearSourcesEnabled(enabled),
    akiflowSources: async () => akiflowSourceState(),
    refreshAkiflowSources,
    setAkiflowSourceEnabled: ({ key, enabled }) => setAkiflowSourceEnabled(key, enabled),
    setAllAkiflowSourcesEnabled: ({ enabled }) => setAllAkiflowSourcesEnabled(enabled),
    providerSettings: async () => providerSettingsState(),
    setProviderEnabled: ({ provider, enabled }) => setProviderEnabled(provider, enabled),
    providerHealth: () => providerHealth(),
    createTaskOptions,
    createTask,
    createProjectTask: ({ projectId, destinationId, title, threadId, priority }) => createProjectTask(projectId, destinationId, title, threadId, priority),
    setProject: ({ taskId, projectId }) => setProject(taskId, projectId),
    arrangeTasks: ({ priority, taskIds }) => arrangeTasks(priority, taskIds),
  });

  bb.ui.registerMentionProvider({
    id: "task",
    label: "Tasks",
    triggers: ["@", "#"],
    async search({ query, projectId }) {
      if (!projectId) return [];
      const needle = query.toLowerCase();
      return (await tasksForProject(projectId)).filter((task) => task.status !== "done"
        && taskSearchValues(task).some((value) => value.toLowerCase().includes(needle)))
        .slice(0, 20).map((task) => ({ id: task.id, title: `${task.identifier}: ${task.title}`, subtitle: task.status }));
    },
    resolve(itemId) {
      return { context: taskAgentContext(getDbTask(itemId)) };
    },
  });
  function resolveOwner(value: string) {
    if (value === "none") return null;
    const roster = owners();
    if (value === "me") {
      const me = roster.find((owner) => owner.isMe);
      if (!me) throw new Error("No “me” owner is known yet. Sync Linear first.");
      return me.id;
    }
    const idMatch = roster.find((owner) => owner.id === value);
    if (idMatch) return idMatch.id;
    const nameMatches = roster.filter((owner) => owner.name.toLowerCase() === value.toLowerCase());
    if (!nameMatches.length) throw new Error(`No owner matches “${value}”. Run: bb worktasks owners`);
    if (nameMatches.length > 1) throw new Error(`Several owners are named “${value}”. Use an owner id from bb worktasks owners`);
    return nameMatches[0]!.id;
  }

  registerTaskAgentIntegration(bb, {
    agentWrites: () => agentWrites === "full" || agentWrites === "workflow" ? agentWrites as AgentWriteLevel : "off",
    tasksForProject,
    taskForProject,
    taskPriority,
    currentTasks: (threadId) => threadTasks(threadId).map(taskDto),
    instructionForThread: (threadId) => threadTasks(threadId).map((task) => taskAgentContext(task)).join("\n\n") || null,
    move: setStatus,
    priority: setPriority,
    assign: (taskId, owner) => setOwner(taskId, resolveOwner(owner)),
    create: async ({ owner, ...input }, projectId) => {
      await assertDestinationProject(input.provider, input.destinationId, projectId);
      const ownerId = owner ? resolveOwner(owner) : null;
      const created = await createTask({
        ...input,
        ownerId: input.provider === "linear" ? ownerId : null,
      });
      return ownerId && input.provider !== "linear" ? setOwner(created.id, ownerId) : created;
    },
    link: (leftTaskId, rightTaskId) => taskDto(getDbTask(mergeTaskRecords(leftTaskId, rightTaskId))),
  });


  bb.cli.register({
    name: "worktasks",
    summary: "Manage synced tasks",
    commands: [
      { name: "list", summary: "List/filter tasks with optional bounded pagination and project scope", usage: "bb worktasks list [--project <id>] [--status s] [--priority p] [--provider p] [--owner me|none|<id>|<name>] [--query text] [--limit <1-100>] [--offset <n>] [--json]" },
      { name: "show", summary: "Show complete source, thread, environment and backed PR context", usage: "bb worktasks show <identifier> [--project <id>] [--json]" },
      { name: "owners", summary: "List assignable owners (Linear workspace members) and their ids", usage: "bb worktasks owners [--json]" },
      { name: "sync", summary: "Sync Akiflow, Linear, and GitHub", usage: "bb worktasks sync" },
      { name: "move", summary: "Move a task through the workflow without starting a chat", usage: "bb worktasks move <identifier> <status>" },
      { name: "priority", summary: "Set a task's normalized priority across its linked sources", usage: "bb worktasks priority <identifier> <none|low|medium|high|urgent>" },
      { name: "assign", summary: "Assign a task's owner (syncs the Linear assignee)", usage: "bb worktasks assign <identifier> <me|none|<id>|<name>>" },
      { name: "attach", summary: "Explicitly start or resume a chat attached to a task", usage: "bb worktasks attach <identifier>" },
      { name: "link", summary: "Link two source tasks", usage: "bb worktasks link <identifier> <other-identifier>" },
      { name: "destinations", summary: "List enabled upstream destinations for new tasks", usage: "bb worktasks destinations" },
      { name: "repos", summary: "List GitHub repositories, refresh the list, or change which ones sync", usage: "bb worktasks repos [--refresh] [--enable <owner/name>] [--disable <owner/name>] [--all] [--json]" },
      { name: "create", summary: "Create a task upstream (optionally with priority/owner)", usage: "bb worktasks create <provider> <destination-id> <title> [description] [--priority p] [--owner me|<id>|<name>]" },
    ],
    async run(argv, ctx) {
      try {
        const [command, ...args] = argv;
        const threadScoped = Boolean(ctx.threadId);
        const scopedProjectId = threadScoped ? ctx.projectId : undefined;
        const writeLevel: AgentWriteLevel = agentWrites === "full" || agentWrites === "workflow" ? agentWrites : "off";
        const requireCliWrite = (required: "workflow" | "full") => {
          if (!threadScoped) return;
          if (writeLevel === "off" || (required === "full" && writeLevel !== "full")) {
            throw new Error(`Agent task changes are ${writeLevel === "off" ? "off" : "limited to workflow fields"}`);
          }
        };
        const scopedTask = async (value: string) => {
          if (!threadScoped) return taskDto(findTask(value));
          if (!scopedProjectId) throw new Error("This thread has no bb project for task access");
          return await taskForProject(value, scopedProjectId);
        };
        if (command === "list") {
          const { flags } = parseCliFlags(args);
          if (flags.project !== undefined || flags.limit !== undefined || flags.offset !== undefined) {
            if (threadScoped && (!scopedProjectId || flags.project && flags.project !== scopedProjectId)) {
              throw new Error("This thread cannot read tasks in another bb project");
            }
            const input = readContract["read.list"].input.parse({
              projectId: scopedProjectId ?? flags.project ?? null, status: flags.status ?? null,
              priority: flags.priority ?? null, provider: flags.provider ?? null, owner: flags.owner ?? null,
              query: flags.query ?? "", limit: flags.limit === undefined ? undefined : Number(flags.limit),
              offset: flags.offset === undefined ? undefined : Number(flags.offset),
            });
            const page = await readTasks(input);
            if (flags.json !== undefined) {
              const stdout = JSON.stringify(page);
              if (Buffer.byteLength(stdout, "utf8") > 900_000) throw new Error("Result exceeds 900 KB; reduce --limit");
              return { exitCode: 0, stdout };
            }
            return { exitCode: 0, stdout: [
              ...page.tasks.map((task) => [
                task.identifier, task.status, taskPriority(task) ?? "-",
                task.owner ? (task.owner.isMe ? "me" : task.owner.name) : "-", task.title,
              ].join("\t")),
              `Showing ${page.tasks.length} of ${page.total} tasks (offset ${page.offset}).`,
            ].join("\n") };
          }
          let tasks = scopedProjectId ? await tasksForProject(scopedProjectId) : threadScoped ? [] : listTasks();
          if (flags.provider) tasks = tasks.filter((task) => task.refs.some((ref) => ref.provider === flags.provider));
          if (flags.status) tasks = tasks.filter((task) => task.status === flags.status);
          if (flags.priority) tasks = tasks.filter((task) => taskPriority(task) === (flags.priority === "none" ? null : flags.priority));
          if (flags.owner) {
            tasks = tasks.filter((task) => flags.owner === "me" ? task.owner?.isMe
              : flags.owner === "none" ? !task.owner
                : task.owner?.id === flags.owner || task.owner?.name.toLowerCase() === flags.owner!.toLowerCase());
          }
          if (flags.query) {
            const needle = flags.query.toLowerCase();
            tasks = tasks.filter((task) => taskSearchValues(task).some((value) => value.toLowerCase().includes(needle)));
          }
          if (flags.json !== undefined) return { exitCode: 0, stdout: JSON.stringify(tasks, null, 2) };
          const stdout = tasks.map((task) => [
            task.identifier,
            task.status,
            taskPriority(task) ?? "-",
            task.owner ? (task.owner.isMe ? "me" : task.owner.name) : "-",
            task.title,
          ].join("\t")).join("\n");
          return { exitCode: 0, stdout };
        }
        if (command === "owners") {
          const { flags } = parseCliFlags(args);
          const roster = owners();
          if (flags.json !== undefined) return { exitCode: 0, stdout: JSON.stringify(roster, null, 2) };
          return { exitCode: 0, stdout: roster.map((owner) => `${owner.id}\t${owner.name}${owner.isMe ? "\t(me)" : ""}`).join("\n") };
        }
        if (command === "assign" && args[0] && args[1]) {
          requireCliWrite("workflow");
          return { exitCode: 0, stdout: JSON.stringify(await setOwner((await scopedTask(args[0])).id, resolveOwner(args[1])), null, 2) };
        }
        if (command === "show" && args[0]) {
          const { flags, positional } = parseCliFlags(args);
          if (positional.length !== 1 || threadScoped && (!scopedProjectId || flags.project && flags.project !== scopedProjectId)) {
            throw new Error("Provide one task identifier in this bb project");
          }
          const input = readContract["read.show"].input.parse({ identifier: positional[0], projectId: scopedProjectId ?? flags.project ?? null });
          const output = JSON.stringify(await readTask(input), null, flags.json === undefined ? 2 : 0);
          if (Buffer.byteLength(output, "utf8") > 900_000) throw new Error("Result exceeds 900 KB");
          return { exitCode: 0, stdout: output };
        }
        if (command === "sync") {
          const result = await syncNow();
          return { exitCode: result.errors.length ? 1 : 0, stdout: JSON.stringify(result, null, 2) };
        }
        if (command === "move" && args[0] && statusSchema.safeParse(args[1]).success) {
          requireCliWrite("workflow");
          return { exitCode: 0, stdout: JSON.stringify(await setStatus((await scopedTask(args[0])).id, args[1] as Status), null, 2) };
        }
        if (command === "priority" && args[0] && (args[1] === "none" || priorityNames.includes(args[1] as Priority))) {
          requireCliWrite("workflow");
          const priority = args[1] === "none" ? null : args[1] as Priority;
          return { exitCode: 0, stdout: JSON.stringify(await setPriority((await scopedTask(args[0])).id, priority), null, 2) };
        }
        if (command === "akiflow-init-tags") {
          requireCliWrite("full");
          return { exitCode: 0, stdout: JSON.stringify(await ensureAkiflowStageTags(), null, 2) };
        }
        if (command === "attach" && args[0]) {
          requireCliWrite("workflow");
          return { exitCode: 0, stdout: JSON.stringify(await attachChat((await scopedTask(args[0])).id), null, 2) };
        }
        if (command === "link" && args[0] && args[1]) {
          requireCliWrite("full");
          const left = await scopedTask(args[0]);
          const right = await scopedTask(args[1]);
          return { exitCode: 0, stdout: JSON.stringify(taskDto(getDbTask(mergeTaskRecords(left.id, right.id))), null, 2) };
        }
        if (command === "repos") {
          const { flags } = parseCliFlags(args);
          const mutating = [flags.refresh, flags.enable, flags.disable].some((value) => value !== undefined);
          // Listing is a read, like `destinations` beside it. Only changing
          // which repositories sync needs the write level.
          if (mutating) requireCliWrite("full");
          // The panel is the only other place these RPCs are reachable, and a
          // stale list is invisible from the CLI: `destinations` shows enabled
          // repositories only, so a repository bb has never seen simply is not
          // there to enable.
          if (flags.refresh !== undefined) await refreshGithubRepositories();
          for (const fullName of [flags.enable, flags.disable].filter((value): value is string => typeof value === "string")) {
            await setGithubRepositoryEnabled(fullName, fullName === flags.enable);
          }
          const state = await githubRepositoryState();
          const shown = flags.all === undefined
            ? state.repositories.filter((repository) => repository.enabled)
            : state.repositories;
          if (flags.json !== undefined) {
            return { exitCode: 0, stdout: JSON.stringify({ configured: state.configured, repositories: shown }, null, 2) };
          }
          if (!state.configured) return { exitCode: 0, stdout: "Set a GitHub token before using repositories." };
          if (!shown.length) {
            return { exitCode: 0, stdout: flags.all === undefined
              ? "No repositories are syncing. Pass --all to see every repository bb can see."
              : "No repositories. Pass --refresh to fetch them from GitHub." };
          }
          const stdout = shown
            .map((repository) => `${repository.enabled ? "[x]" : "[ ]"}\t${repository.fullName}`)
            .join("\n");
          return { exitCode: 0, stdout };
        }
        if (command === "destinations") {
          const options = await createTaskOptions();
          const lines: string[] = [];
          for (const { provider, destinations } of options.providers) {
            for (const destination of destinations) {
              if (scopedProjectId) {
                try {
                  await assertDestinationProject(provider, destination.id, scopedProjectId);
                } catch {
                  continue;
                }
              } else if (threadScoped) {
                continue;
              }
              lines.push(`${provider}\t${destination.id}\t${destination.label}${destination.detail ? ` · ${destination.detail}` : ""}`);
            }
          }
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        if (command === "create" && providerSchema.safeParse(args[0]).success) {
          const provider = args[0] as Provider;
          const { flags, positional } = parseCliFlags(args.slice(1));
          const [destinationId, title, ...descriptionParts] = positional;
          if (!destinationId || !title) {
            return { exitCode: 2, stderr: "Usage: bb worktasks create <provider> <destination-id> <title> [description] [--priority none|low|medium|high|urgent] [--owner me|<id>|<name>]" };
          }
          requireCliWrite("full");
          if (scopedProjectId) await assertDestinationProject(provider, destinationId, scopedProjectId);
          else if (threadScoped) throw new Error("This thread has no bb project for task creation");
          const priority = flags.priority && flags.priority !== "none" ? flags.priority as Priority : null;
          const ownerId = flags.owner ? resolveOwner(flags.owner) : null;
          // Linear takes the assignee natively at creation; Akiflow/GitHub reject it there, so
          // create first and assign the owner locally afterward.
          const created = await createTask({
            provider,
            destinationId,
            title,
            description: descriptionParts.join(" "),
            priority,
            ownerId: provider === "linear" ? ownerId : null,
          });
          const result = ownerId && provider !== "linear" ? await setOwner(created.id, ownerId) : created;
          return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
        }
        return { exitCode: 2, stderr: "Usage: bb worktasks <list|show|sync|move|priority|assign|owners|attach|link|destinations|create> ..." };
      } catch (error) {
        return { exitCode: 1, stderr: errorMessage(error) };
      }
    },
  });

  bb.background.schedule("sync", "*/15 * * * *", async () => {
    const result = await syncNow();
    if (result.errors.length) throw new Error(result.errors.join("; "));
  });
  bb.background.schedule("pull-requests", "*/2 * * * *", checkPullRequests);
  bb.log.info("Tasks loaded");
}
