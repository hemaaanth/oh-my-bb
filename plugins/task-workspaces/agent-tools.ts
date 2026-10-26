import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { UNTRUSTED_TASK_POLICY } from "./task-context";

const toolNames = {
  current: "worktask_current",
  get: "worktask_get",
  list: "worktask_list",
  search: "worktask_search",
  move: "worktask_move",
  priority: "worktask_priority",
  assign: "worktask_assign",
  create: "worktask_create",
  link: "worktask_link",
} as const;
const readTools = [toolNames.current, toolNames.get, toolNames.list, toolNames.search];
const workflowTools = [toolNames.move, toolNames.priority, toolNames.assign];
const fullTools = [toolNames.create, toolNames.link];
const statusValues = ["triage", "backlog", "todo", "doing", "blocked", "review", "done", "cancelled"] as const;
const providerValues = ["akiflow", "linear", "github"] as const;
const priorityValues = ["urgent", "high", "medium", "low"] as const;
const priorityFilterValues = [...priorityValues, "none"] as const;

export type AgentWriteLevel = "off" | "workflow" | "full";
type TaskStatus = typeof statusValues[number];
type TaskProvider = typeof providerValues[number];
type TaskPriority = typeof priorityValues[number];

type TaskView = {
  id: string;
  identifier: string;
  title: string;
  status: TaskStatus;
  owner: { id: string; name: string; isMe: boolean } | null;
  refs: Array<{ provider: TaskProvider; priority: TaskPriority | null }>;
};

function taskListItem(task: TaskView, priority: TaskPriority | null) {
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    owner: task.owner,
    providers: [...new Set(task.refs.map((ref) => ref.provider))],
    priority,
  };
}


type TaskAgentDeps = {
  agentWrites: () => AgentWriteLevel;
  tasksForProject: (projectId: string) => Promise<TaskView[]>;
  taskForProject: (value: string, projectId: string) => Promise<TaskView>;
  taskPriority: (task: TaskView) => TaskPriority | null;
  currentTasks: (threadId: string) => TaskView[];
  instructionForThread: (threadId: string) => string | null;
  move: (taskId: string, status: TaskStatus) => Promise<TaskView>;
  priority: (taskId: string, priority: TaskPriority | null) => Promise<TaskView>;
  assign: (taskId: string, owner: string) => Promise<TaskView>;
  create: (input: {
    provider: TaskProvider;
    destinationId: string;
    title: string;
    description: string;
    priority: TaskPriority | null;
    owner: string | null;
  }, projectId: string) => Promise<TaskView>;
  link: (leftTaskId: string, rightTaskId: string) => TaskView;
};

export function registerTaskAgentIntegration(bb: BbPluginApi, deps: TaskAgentDeps) {
  function requireWriteLevel(required: Exclude<AgentWriteLevel, "off">) {
    const current = deps.agentWrites();
    if (current === "off" || (required === "full" && current !== "full")) {
      throw new Error(`Agent task changes are ${current === "off" ? "off" : "limited to workflow fields"}. Change “Agent task changes” in Tasks settings to continue.`);
    }
  }

  bb.agents.registerTool({
    name: toolNames.current,
    description: "Read the tasks attached to this bb thread.",
    presentation: {
      label: { pending: "Reading current task", completed: "Read current task" },
      icon: { glyph: "FileText" },
    },
    parameters: z.object({}).strict(),
    execute: (_input, ctx) => {
      const tasks = deps.currentTasks(ctx.threadId);
      if (!tasks.length) return "This thread is not attached to a task.";
      return JSON.stringify(tasks.length === 1 ? tasks[0] : tasks, null, 2);
    },
  });

  bb.agents.registerTool({
    name: toolNames.get,
    description: "Read one task with its current provider data and linked references.",
    instructions: UNTRUSTED_TASK_POLICY,
    presentation: {
      label: { pending: "Reading task", completed: "Read task" },
      icon: { glyph: "FileText" },
    },
    parameters: z.object({ task: z.string().min(1) }).strict(),
    execute: async ({ task }, ctx) => JSON.stringify(await deps.taskForProject(task, ctx.projectId), null, 2),
  });

  bb.agents.registerTool({
    name: toolNames.list,
    description: "List tasks in this bb project, optionally filtered by stage, priority, provider, or text.",
    presentation: {
      label: { pending: "Listing project tasks", completed: "Listed project tasks" },
      icon: { glyph: "task-workspaces/tasks" },
    },
    parameters: z.object({
      status: z.enum(statusValues).optional(),
      priority: z.enum(priorityFilterValues).optional(),
      provider: z.enum(providerValues).optional(),
      query: z.string().optional(),
    }).strict(),
    execute: async ({ status, priority, provider, query }, ctx) => {
      const needle = query?.trim().toLowerCase();
      const tasks = (await deps.tasksForProject(ctx.projectId)).filter((task) => {
        if (status && task.status !== status) return false;
        if (provider && !task.refs.some((ref) => ref.provider === provider)) return false;
        const effectivePriority = deps.taskPriority(task);
        if (priority && effectivePriority !== (priority === "none" ? null : priority)) return false;
        return !needle || `${task.identifier} ${task.title}`.toLowerCase().includes(needle);
      });
      return JSON.stringify(tasks.map((task) => taskListItem(task, deps.taskPriority(task))), null, 2);
    },
  });

  bb.agents.registerTool({
    name: toolNames.search,
    description: "Search task identifiers and titles in this bb project.",
    presentation: {
      label: { pending: "Searching project tasks", completed: "Searched project tasks" },
      icon: { glyph: "Search" },
    },
    parameters: z.object({ query: z.string().trim().min(1) }).strict(),
    execute: async ({ query }, ctx) => {
      const needle = query.toLowerCase();
      const tasks = (await deps.tasksForProject(ctx.projectId))
        .filter((task) => `${task.identifier} ${task.title}`.toLowerCase().includes(needle));
      return JSON.stringify(tasks.map((task) => taskListItem(task, deps.taskPriority(task))), null, 2);
    },
  });

  bb.agents.registerTool({
    name: toolNames.move,
    description: "Move a task to a normalized workflow stage.",
    presentation: {
      label: { pending: "Moving task", completed: "Moved task" },
      icon: { glyph: "Workflow" },
    },
    parameters: z.object({
      task: z.string().min(1),
      status: z.enum(statusValues),
    }).strict(),
    execute: async ({ task, status }, ctx) => {
      requireWriteLevel("workflow");
      return JSON.stringify(await deps.move((await deps.taskForProject(task, ctx.projectId)).id, status), null, 2);
    },
  });

  bb.agents.registerTool({
    name: toolNames.priority,
    description: "Set a task's normalized priority across linked providers.",
    presentation: {
      label: { pending: "Updating task priority", completed: "Updated task priority" },
      icon: { glyph: "SlidersHorizontal" },
    },
    parameters: z.object({
      task: z.string().min(1),
      priority: z.enum(priorityFilterValues),
    }).strict(),
    execute: async ({ task, priority }, ctx) => {
      requireWriteLevel("workflow");
      const id = (await deps.taskForProject(task, ctx.projectId)).id;
      return JSON.stringify(await deps.priority(id, priority === "none" ? null : priority), null, 2);
    },
  });

  bb.agents.registerTool({
    name: toolNames.assign,
    description: "Assign a task to me, none, a known owner id, or an exact owner name.",
    presentation: {
      label: { pending: "Assigning task", completed: "Assigned task" },
      icon: { glyph: "UserRound" },
    },
    parameters: z.object({ task: z.string().min(1), owner: z.string().min(1) }).strict(),
    execute: async ({ task, owner }, ctx) => {
      requireWriteLevel("workflow");
      return JSON.stringify(await deps.assign((await deps.taskForProject(task, ctx.projectId)).id, owner), null, 2);
    },
  });

  bb.agents.registerTool({
    name: toolNames.create,
    description: "Create a task in an enabled upstream provider destination.",
    presentation: {
      label: { pending: "Creating task", completed: "Created task" },
      icon: { glyph: "Plus" },
    },
    parameters: z.object({
      provider: z.enum(providerValues),
      destinationId: z.string().min(1),
      title: z.string().trim().min(1).max(500),
      description: z.string().max(100_000).default(""),
      priority: z.enum(priorityValues).nullable().default(null),
      owner: z.string().nullable().default(null),
    }).strict(),
    execute: async ({ owner, ...input }, ctx) => {
      requireWriteLevel("full");
      return JSON.stringify(await deps.create({ ...input, owner }, ctx.projectId), null, 2);
    },
  });

  bb.agents.registerTool({
    name: toolNames.link,
    description: "Link two task records that represent the same work across providers.",
    presentation: {
      label: { pending: "Linking tasks", completed: "Linked tasks" },
      icon: { glyph: "GitMerge" },
    },
    parameters: z.object({ task: z.string().min(1), otherTask: z.string().min(1) }).strict(),
    execute: async ({ task, otherTask }, ctx) => {
      requireWriteLevel("full");
      const left = await deps.taskForProject(task, ctx.projectId);
      const right = await deps.taskForProject(otherTask, ctx.projectId);
      return JSON.stringify(deps.link(left.id, right.id), null, 2);
    },
  });

  bb.agents.configure(() => ({
    tools: [
      ...readTools,
      ...(deps.agentWrites() === "off" ? [] : workflowTools),
      ...(deps.agentWrites() === "full" ? fullTools : []),
    ],
    skills: ["task-workspaces"],
  }));
  bb.agents.contributeInstructions(({ threadId }) => deps.instructionForThread(threadId));
}
