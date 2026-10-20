// start_thread (SPEC §11.8). Picks the project, machine, provider and model,
// then spawns the thread. Without a prompt it only names the project for the
// New thread screen. Owned by P1.
import type { ToolContext } from "../../shared/contract.js";
import type { ServerContext } from "../context.js";
import { threadTitle } from "./live.js";
import {
  defaultSourceHost,
  providersFor,
  resolveMachine,
  resolveModel,
  resolveProvider,
  routingTarget,
  type HostRow,
  type ProjectRow,
} from "./resolve.js";
import { compact, machineOf, openOnDesktop, optionalString, type ToolArgs } from "./threads.js";

type Sdk = ServerContext["bb"]["sdk"];
export type SpawnEnvironment = Parameters<Sdk["threads"]["spawn"]>[0]["environment"];

export const NEW_THREAD_SCREEN_NOTE = "The New thread screen is open for the user to type.";
export const NOT_ON_SCREEN_NOTE = "The thread was not brought on screen.";

/** Given id, else the session's project, else the personal project. */
export function pickProject(projects: readonly ProjectRow[], projectId: string | undefined, context: ToolContext): ProjectRow {
  if (projectId) {
    const found = projects.find((project) => project.id === projectId);
    if (!found) throw new Error(`There is no project with id ${projectId}. Look it up with list_projects.`);
    return found;
  }
  const current = context.projectId ? projects.find((project) => project.id === context.projectId) : undefined;
  if (current) return current;
  const personal = projects.find((project) => project.kind === "personal");
  if (personal) return personal;
  throw new Error("No project was given and there is no current or personal project. Name a project.");
}

/**
 * The spawn environment. Personal project → personal workspace. A named host
 * on a git project → a managed worktree on the default branch; on a project
 * without git → the unmanaged source path. Otherwise the project's default.
 */
export function pickEnvironment(project: ProjectRow, host: HostRow | null): SpawnEnvironment {
  if (project.kind === "personal") {
    const hostId = host?.id ?? defaultSourceHost(project);
    if (hostId) return { type: "host", hostId, workspace: { type: "personal" } };
    return { type: "project-default" };
  }
  if (!host) return { type: "project-default" };
  if (project.gitRemoteUrl) {
    return { type: "host", hostId: host.id, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } };
  }
  const source = project.sources.find((entry) => entry.hostId === host.id);
  if (!source) {
    throw new Error(`${host.name} does not hold the project ${project.name}. Pick a machine that has it, or leave the machine out.`);
  }
  return { type: "host", hostId: host.id, workspace: { type: "unmanaged", path: source.path } };
}

export async function startThread(ctx: ServerContext, args: ToolArgs, context: ToolContext): Promise<string> {
  const sdk = ctx.bb.sdk;
  const machineQuery = optionalString(args, "machine_id");
  const [projects, hosts] = await Promise.all([sdk.projects.list(), machineQuery ? sdk.hosts.list() : Promise.resolve([])]);
  const project = pickProject(projects, optionalString(args, "project_id"), context);
  const host = machineQuery ? resolveMachine(machineQuery, hosts) : null;

  const prompt = optionalString(args, "prompt");
  if (!prompt) {
    return compact({
      newThreadScreen: true,
      projectId: project.id,
      projectName: project.name,
      ...(host ? { machineId: host.id, machineName: host.name } : {}),
      note: NEW_THREAD_SCREEN_NOTE,
    });
  }

  const providerQuery = optionalString(args, "provider_id");
  const modelQuery = optionalString(args, "model");
  let providerId: string | undefined;
  let providerName: string | undefined;
  let modelId: string | undefined;
  let modelName: string | undefined;
  if (providerQuery || modelQuery) {
    const providers = await providersFor(ctx, routingTarget({ hostId: host?.id ?? null, project }));
    const provider = providerQuery ? resolveProvider(providerQuery, providers) : undefined;
    if (modelQuery) {
      const chosen = resolveModel(modelQuery, provider ? [provider] : providers);
      providerId = chosen.provider.id;
      providerName = chosen.provider.displayName;
      modelId = chosen.model.id;
      modelName = chosen.model.displayName;
    } else if (provider) {
      providerId = provider.id;
      providerName = provider.displayName;
    }
  }

  const title = optionalString(args, "title");
  const spawned = await sdk.threads.spawn({
    projectId: project.id,
    environment: pickEnvironment(project, host),
    prompt,
    ...(title ? { title } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { model: modelId } : {}),
    origin: "plugin",
  });

  const thread = await sdk.threads.get({ threadId: spawned.id, include: "environment" }).catch(() => null);
  await openOnDesktop(ctx, spawned.id, context);
  return compact({
    threadId: spawned.id,
    title: thread ? threadTitle(thread) : (title ?? "Untitled thread"),
    projectName: project.name,
    machineName: (thread ? machineOf(thread) : null) ?? host?.name ?? "the project's default machine",
    ...(providerName ? { provider: providerName } : {}),
    ...(modelName ? { model: modelName } : {}),
    ...(context.focus === false ? { note: NOT_ON_SCREEN_NOTE } : {}),
  });
}
