import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  agentDocumentFileSchema,
  exportSchema,
  missionScheduleIntervalSchema,
  reasoningLevels,
  rpcContract,
  type AgentDocumentFile,
  type Profile,
} from "./contract";
import {
  agentAuthor,
  authorizeChannel,
  channelReaction,
  creatorMembers,
  type ChannelRpcHandlers,
  type SendMessage,
} from "./channels/rpc";
import {
  channelAutomationCreateSchema,
  channelAutomationListSchema,
  channelAutomationRunSchema,
  channelAutomationTargetSchema,
  channelAutomationUpdateSchema,
  type ChannelAutomation,
} from "./channels/automation-contract";
import type { ChannelAutomations } from "./channels/channel-automations";
import type { Store } from "./channels/store";
import { refreshConversations, snapshot, type Profiles } from "./profiles";
import type { Runtime } from "./channels/runtime";
import { modelLevelLabel, modelLevels, type ModelLevel } from "./model-levels";
import { previewAgentHistory } from "./dm-migration";

type Method = keyof ChannelRpcHandlers;
type Output<K extends Method> = z.output<(typeof rpcContract)[K]["output"]>;
type Publisher = (
  threadId: string,
  path: string,
  alt?: string,
) => Promise<unknown>;

const jsonOption = {
  json: {
    type: "boolean",
    description: "Emit machine-readable JSON",
  },
} as const;
const documentOptions = {
  text: {
    type: "string",
    description: "Replace the document with this text",
    placeholder: "TEXT",
    stdin: true,
  },
  file: {
    type: "string",
    description: "Replace the document with UTF-8 text from this path",
    placeholder: "PATH",
  },
  version: {
    type: "string",
    description: "Require this current document SHA-256 before saving",
    placeholder: "HASH",
  },
  ...jsonOption,
} as const;

function scheduleInterval(value: string): number | null {
  if (value.toLowerCase() === "off") return null;
  const match = /^(\d+)(m|h|d)$/i.exec(value);
  if (!match) {
    throw new PluginCliError("Use a duration such as 30m, 1h, 4h, 1d, or off.", {
      code: "invalid_schedule",
    });
  }
  const amount = Number(match[1]);
  const minutes = amount * (match[2]!.toLowerCase() === "d"
    ? 1_440
    : match[2]!.toLowerCase() === "h"
    ? 60
    : 1);
  const parsed = missionScheduleIntervalSchema.safeParse(minutes);
  if (!parsed.success) {
    throw new PluginCliError("Mission schedules must be between 15 minutes and 1 week.", {
      code: "invalid_schedule",
    });
  }
  return parsed.data;
}

function scheduleLabel(minutes: number | null) {
  if (minutes === null) return "Off";
  if (minutes % 1_440 === 0)
    return `Every ${minutes / 1_440} ${minutes === 1_440 ? "day" : "days"}`;
  if (minutes % 60 === 0)
    return `Every ${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `Every ${minutes} minutes`;
}

function nextWakeLabel(nextWakeAt: number | null, paused: boolean, retired: boolean) {
  if (retired) return "Next wake: retired";
  if (paused) return "Next wake: paused";
  if (nextWakeAt === null) return "Next wake: none";
  return `Next wake: ${new Date(nextWakeAt).toISOString()}`;
}
type AutomationScheduleOptions = {
  at?: string;
  cron?: string;
  timezone?: string;
};

function automationTrigger(
  options: AutomationScheduleOptions,
  required: boolean,
) {
  if (options.at && (options.cron || options.timezone)) {
    throw new PluginCliError(
      "Choose either --at or --cron with --timezone.",
      { code: "invalid_schedule" },
    );
  }
  if (options.at) {
    const runAt = Date.parse(options.at);
    if (!Number.isFinite(runAt)) {
      throw new PluginCliError("--at must be an ISO date and time.", {
        code: "invalid_schedule",
      });
    }
    return { triggerType: "once" as const, runAt };
  }
  if (options.cron || options.timezone) {
    if (!options.cron || !options.timezone) {
      throw new PluginCliError(
        "Recurring schedules require both --cron and --timezone.",
        { code: "invalid_schedule" },
      );
    }
    return {
      triggerType: "schedule" as const,
      cron: options.cron,
      timezone: options.timezone,
    };
  }
  if (required) {
    throw new PluginCliError(
      "Choose --at or provide both --cron and --timezone.",
      { code: "missing_schedule" },
    );
  }
  return undefined;
}

function automationScheduleLabel(automation: ChannelAutomation) {
  if (automation.trigger.triggerType === "once")
    return `once ${new Date(automation.trigger.runAt).toISOString()}`;
  return `${automation.trigger.cron} (${automation.trigger.timezone})`;
}

function success(data: unknown, human: string, json: boolean): PluginCliResult {
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(data, null, 2) : human,
  };
}

function commandError(error: unknown): never {
  if (error instanceof PluginCliError) throw error;
  throw new PluginCliError(
    error instanceof Error ? error.message : String(error),
    { code: "operation_failed" },
  );
}

async function attempt<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    commandError(error);
  }
}

function resolveAgent(profiles: Profiles, selector: string): Profile {
  const all = profiles.listProfiles();
  const byId = all.find((profile) => profile.id === selector);
  if (byId) return byId;
  if (selector.startsWith("@")) {
    const slug = selector.slice(1).toLowerCase();
    const profile = all.find((candidate) => candidate.slug.toLowerCase() === slug);
    if (profile) return profile;
  } else {
    const name = selector.toLowerCase();
    const matches = all.filter((profile) => profile.name.toLowerCase() === name);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new PluginCliError(
        "Agent name is ambiguous; use its UUID or @slug.",
        { code: "ambiguous_agent" },
      );
    }
  }
  throw new PluginCliError(`Agent not found: ${selector}`, {
    code: "agent_not_found",
    hint: "Run `bb agents list` to see available agents.",
  });
}

async function readCliFile(
  bb: BbPluginApi,
  ctx: PluginCliContext,
  path: string,
  maxBytes: number,
) {
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(path)
    || /^[A-Za-z]:[\\/]|^\\\\/.test(ctx.cwd ?? "")
    ? win32
    : posix;
  if (!paths.isAbsolute(path) && !ctx.cwd) {
    throw new PluginCliError(
      "Use an absolute file path when the working directory is unavailable.",
      { code: "missing_working_directory" },
    );
  }
  let hostId: string | undefined;
  if (ctx.threadId) {
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
    if (thread.environmentId) {
      hostId = (
        await bb.sdk.environments.get({ environmentId: thread.environmentId })
      ).hostId;
    }
  }
  const result = await bb.sdk.files.read({
    hostId,
    path: paths.isAbsolute(path) ? path : paths.resolve(ctx.cwd!, path),
    signal: ctx.signal,
  });
  const bytes = Buffer.from(result.content, result.contentEncoding);
  if (result.sizeBytes !== bytes.length || bytes.length > maxBytes) {
    throw new PluginCliError(`File must fit within ${maxBytes} bytes and be read in full.`, {
      code: "file_too_large",
    });
  }
  return {
    bytes,
    mimeType: result.mimeType ?? "application/octet-stream",
    name: paths.basename(path),
  };
}

async function readTextFile(
  bb: BbPluginApi,
  ctx: PluginCliContext,
  path: string,
  maxBytes: number,
) {
  const { bytes } = await readCliFile(bb, ctx, path, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PluginCliError("File must contain valid UTF-8 text.", {
      code: "invalid_file_encoding",
    });
  }
}

export function registerCli(
  bb: BbPluginApi,
  profiles: Profiles,
  store: Store,
  runtime: Runtime,
  handlers: ChannelRpcHandlers,
  sendMessage: SendMessage,
  publishImage: Publisher,
  publishFile: Publisher,
  automations: ChannelAutomations,
) {
  async function call<K extends Method>(
    method: K,
    input: unknown,
  ): Promise<Output<K>> {
    const parsed = rpcContract[method].input.parse(input);
    const value = await handlers[method](parsed as never);
    return rpcContract[method].output.parse(value) as Output<K>;
  }

  function channel(selector: string, ctx: PluginCliContext) {
    const rooms = store.rooms();
    const room = rooms.find((candidate) => candidate.id === selector)
      ?? rooms.find((candidate) =>
        candidate.name.localeCompare(selector, undefined, {
          sensitivity: "accent",
        }) === 0
      );
    if (!room) {
      throw new PluginCliError(`Channel not found: ${selector}`, {
        code: "channel_not_found",
        hint: "Run `bb agents channel list` to see available channels.",
      });
    }
    if (ctx.threadId) authorizeChannel(store, ctx.threadId, room.id);
    return room;
  }

  function caller(ctx: PluginCliContext) {
    return ctx.threadId ? agentAuthor(store, ctx.threadId) : undefined;
  }

  function ownAgent(selector: string, ctx: PluginCliContext) {
    const profile = resolveAgent(profiles, selector);
    const author = caller(ctx);
    if (author?.agentId && author.agentId !== profile.id) {
      throw new PluginCliError(
        "An agent can only administer its own profile, mission, and memory.",
        { code: "agent_access_denied" },
      );
    }
    return profile;
  }

  function ownJob(id: string, ctx: PluginCliContext) {
    const job = store.job(id);
    const author = caller(ctx);
    if (!job || (author?.agentId && author.agentId !== job.agentId)) {
      throw new PluginCliError("Work item is not available to this caller.", {
        code: "job_not_found",
      });
    }
    return job;
  }

  function requireChannelOwner(ctx: PluginCliContext) {
    if (caller(ctx)?.agentId) {
      throw new PluginCliError(
        "Only the channel owner can change membership, archive, restore, or delete a channel.",
        { code: "channel_owner_required" },
      );
    }
  }

  function output(data: unknown, json: boolean, human?: string) {
    return success(data, human ?? JSON.stringify(data, null, 2), json);
  }
  async function resolveMachine(selector: string) {
    const hosts = await bb.sdk.hosts.list();
    const byId = hosts.find((host) => host.id === selector);
    if (byId) return byId;
    const matches = hosts.filter((host) =>
      host.name.toLocaleLowerCase() === selector.toLocaleLowerCase()
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new PluginCliError(`Machine name "${selector}" is ambiguous. Use a machine ID.`, { code: "ambiguous_machine" });
    throw new PluginCliError(`Unknown machine: ${selector}`, { code: "machine_not_found" });
  }
  async function runsInLabel(profile: Profile) {
    if (!profile.runProjectId) return "caller's environment";
    let projectLabel: string;
    try {
      const project = await bb.sdk.projects.get({ projectId: profile.runProjectId });
      projectLabel = `${project.name} (${project.id})`;
    } catch {
      projectLabel = `${profile.runProjectId} (missing project)`;
    }
    if (!profile.runInCheckout) return projectLabel;
    if (!profile.runHostId) return `${projectLabel}, project checkout`;
    try {
      const host = await bb.sdk.hosts.get({ hostId: profile.runHostId });
      return `${projectLabel}, project checkout on machine ${host.name} (${host.id})`;
    } catch {
      return `${projectLabel}, project checkout on machine ${profile.runHostId} (missing machine)`;
    }
  }
  async function documentCommand(
    profile: Profile,
    file: AgentDocumentFile,
    options: {
      text?: string;
      file?: string;
      version?: string;
      json: boolean;
    },
    ctx: PluginCliContext,
  ) {
    if (profile.kind === "thin")
      throw new PluginCliError("This agent has no mission or persona.", {
        code: "thin_agent",
      });
    const replacement = options.file
      ? await readTextFile(bb, ctx, options.file, 256_000)
      : options.text;
    if (replacement !== undefined && replacement.length > 64_000) {
      throw new PluginCliError("Agent documents cannot exceed 64,000 characters.", {
        code: "document_too_large",
      });
    }
    const current = await profiles.homes.agentDocument(profile, file);
    if (replacement === undefined) {
      if (options.version) {
        throw new PluginCliError("--version applies only to a document update.", {
          code: "invalid_option_combination",
        });
      }
      return success(current, current.text, options.json);
    }
    const saved = await profiles.homes.saveAgentDocument(
      profile,
      file,
      replacement,
      options.version ?? current.version,
      "You",
    );
    return success(
      saved,
      `Updated ${file} for @${profile.slug}.\nVersion: ${saved.version}`,
      options.json,
    );
  }

  async function updateExecution(
    profile: Profile,
    change: { modelMode: Profile["modelMode"]; level?: ModelLevel; providerId?: string; model?: string; reasoningLevel?: Profile["reasoningLevel"] },
  ) {
    const saved = await profiles.saveProfile({
      ...snapshot(profile),
      ...change,
    }, profile.revision);
    await refreshConversations(bb, store, runtime, profile, saved);
    bb.realtime.publish("profiles-changed", {
      reason: "saved",
      profileId: saved.id,
    });
    return saved;
  }

  bb.cli.register(defineCli({
    name: "agents",
    summary: "Manage persistent agents",
    description: "Selectors accept an agent UUID, @slug, or unique name.",
    commands: {
      migration: cliCommand({
        summary: "Preview legacy agent thread history and cutover blockers",
        options: jsonOption,
        async run({ options }) {
          return attempt(async () => {
            const preview = await previewAgentHistory(bb, profiles.db, profiles.listProfiles());
            const ledger = profiles.db.prepare(`SELECT thread_id AS threadId, profile_id AS profileId,
              provider_id AS providerId, model, predecessor, phase, new_dm_id AS newDmId
              FROM dm_migration ORDER BY profile_id, thread_id`).all();
            return success({ ...preview, ledger },
              `${preview.entries.length} legacy history threads; ${preview.ambiguous.length} ambiguous profiles; ${preview.blocked.length} blockers.`,
              options.json);
          });
        },
      }),
      list: cliCommand({
        summary: "List agents",
        options: jsonOption,
        async run({ options }) {
          const values = profiles.listProfiles();
          const human = values.map((profile) =>
            `${profile.isDefault ? "*" : " "} @${profile.slug}\t${profile.modelMode === "level" ? modelLevelLabel(profile.level) : profile.model}`
          ).join("\n");
          return success(values, human || "No agents.", options.json);
        },
      }),
      show: cliCommand({
        summary: "Show an agent profile and home",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const profile = ownAgent(positionals.agent, ctx);
            const schedule = profile.kind === "full" ? store.missionSchedule(profile.id) : null;
            const home = profiles.homes.detail(profile.id);
            const human = [
              `Type: ${profile.kind}`,
              `@${profile.slug}  ${profile.name}`,
              `ID: ${profile.id}`,
              `Description: ${profile.description}`,
              `Runs in: ${await runsInLabel(profile)}`,
              "Harness: Pi with shared long memory",
              `Model mode: ${profile.modelMode}`,
              `Level: ${modelLevelLabel(profile.level)}`,
              ...(profile.modelMode === "pinned"
                ? [`Provider: ${profile.providerId}`, `Model: ${profile.model}`, `Reasoning: ${profile.reasoningLevel}`]
                : []),
              `Service tier: ${profile.serviceTier}`,
              "Permission mode: full",
              `Revision: ${profile.revision}`,
              `Default: ${profile.isDefault ? "yes" : "no"}`,
              `Home: ${home.ready ? home.path : "not initialized"}`,
              ...(schedule
                ? [`Schedule: ${scheduleLabel(schedule.intervalMinutes)}`, nextWakeLabel(schedule.nextWakeAt, schedule.paused, schedule.retired)]
                : []),
            ].join("\n");
            return success({ profile, home, schedule }, human, options.json);
          });
        },
      }),
      kind: cliCommand({
        summary: "Set an agent type",
        positionals: [
          { name: "agent", description: "Agent UUID, @slug, or unique name", required: true },
          { name: "kind", description: "full or thin", required: true },
        ],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const kind = positionals.kind;
            if (kind !== "full" && kind !== "thin")
              throw new PluginCliError("Type must be full or thin.", { code: "invalid_agent_kind" });
            const previous = ownAgent(positionals.agent, ctx);
            const saved = await profiles.saveProfile({ ...snapshot(previous), kind }, previous.revision);
            await refreshConversations(bb, store, runtime, previous, saved);
            bb.realtime.publish("profiles-changed", { reason: "saved", profileId: saved.id });
            return success(saved, `Set @${saved.slug} to ${kind}.`, options.json);
          });
        },
      }),
      sidebar: cliCommand({
        summary: "Show or hide an agent in the sidebar and its DM",
        positionals: [
          { name: "agent", description: "Agent UUID, @slug, or unique name", required: true },
          { name: "state", description: "on or off", required: true },
        ],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const state = positionals.state;
            if (state !== "on" && state !== "off")
              throw new PluginCliError("State must be on or off.", { code: "invalid_sidebar_state" });
            const previous = ownAgent(positionals.agent, ctx);
            const saved = await profiles.saveProfile({ ...snapshot(previous), showInSidebar: state === "on" }, previous.revision);
            await refreshConversations(bb, store, runtime, previous, saved);
            bb.realtime.publish("profiles-changed", { reason: "saved", profileId: saved.id });
            return success(saved, `${state === "on" ? "Showed" : "Hid"} @${saved.slug} in the sidebar.`, options.json);
          });
        },
      }),
      "runs-in": cliCommand({
        summary: "Set where an agent runs",
        positionals: [
          {
            name: "agent",
            description: "Agent UUID, @slug, or unique name",
            required: true,
          },
          {
            name: "project",
            description: "Fixed project ID, or caller to use the caller's environment",
            required: true,
          },
        ],
        options: {
          ...jsonOption,
          checkout: {
            type: "boolean",
            description: "Work in the project's checkout instead of a new worktree per thread",
          },
          machine: {
            type: "string",
            description: "Use the project checkout on this machine (ID or unique name; requires --checkout)",
            placeholder: "MACHINE",
          },
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const previous = ownAgent(positionals.agent, ctx);
            const runProjectId = positionals.project === "caller"
              ? null
              : positionals.project;
            const runInCheckout = Boolean(runProjectId && options.checkout);
            if (options.machine && !runInCheckout)
              throw new PluginCliError("--machine requires a fixed project and --checkout.", { code: "invalid_option_combination" });
            const runHostId = options.machine
              ? (await resolveMachine(options.machine)).id
              : null;
            const saved = await profiles.saveProfile(
              { ...snapshot(previous), runProjectId, runHostId, runInCheckout },
              previous.revision,
            );
            await refreshConversations(bb, store, runtime, previous, saved);
            bb.realtime.publish("profiles-changed", {
              reason: "saved",
              profileId: saved.id,
            });
            return success(
              saved,
              `Set @${saved.slug} to run in ${await runsInLabel(saved)}.`,
              options.json,
            );
          });
        },
      }),
      level: cliCommand({
        summary: "Set an agent model level",
        positionals: [
          {
            name: "agent",
            description: "Agent UUID, @slug, or unique name",
            required: true,
          },
          {
            name: "level",
            description: "xhigh, high, medium, low, or xlow",
            required: true,
          },
        ],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const level = modelLevels.find((candidate) => candidate === positionals.level);
            if (!level) {
              throw new PluginCliError(
                "Level must be xhigh, high, medium, low, or xlow.",
                { code: "invalid_model_level" },
              );
            }
            const saved = await updateExecution(
              ownAgent(positionals.agent, ctx),
              { modelMode: "level", level },
            );
            return success(
              saved,
              `Set @${saved.slug} to ${modelLevelLabel(saved.level)}.`,
              options.json,
            );
          });
        },
      }),
      pin: cliCommand({
        summary: "Pin an agent to an exact model",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: {
          provider: {
            type: "string",
            required: true,
            description: "Pi route: hempi or model-gateway",
            placeholder: "hempi",
          },
          model: {
            type: "string",
            required: true,
            description: "Exact model ID",
            placeholder: "MODEL",
          },
          reasoning: {
            type: "enum",
            values: [...reasoningLevels],
            required: true,
            description: "Exact reasoning level",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const saved = await updateExecution(
              ownAgent(positionals.agent, ctx),
              {
                modelMode: "pinned",
                providerId: options.provider,
                model: options.model,
                reasoningLevel: options.reasoning,
              },
            );
            return success(
              saved,
              `Pinned @${saved.slug} to ${saved.providerId} · ${saved.model} · ${saved.reasoningLevel}.`,
              options.json,
            );
          });
        },
      }),
      mission: cliCommand({
        summary: "Read or update MISSION.md",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: documentOptions,
        constraints: [{ kind: "at-most-one", options: ["text", "file"] }],
        async run({ positionals, options }, ctx) {
          return attempt(() =>
            documentCommand(
              ownAgent(positionals.agent, ctx),
              "MISSION.md",
              options,
              ctx,
            )
          );
        },
      }),
      persona: cliCommand({
        summary: "Read or update the agent's persona (PERSONA.md)",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: documentOptions,
        constraints: [{ kind: "at-most-one", options: ["text", "file"] }],
        async run({ positionals, options }, ctx) {
          return attempt(() =>
            documentCommand(
              ownAgent(positionals.agent, ctx),
              "PERSONA.md",
              options,
              ctx,
            )
          );
        },
      }),
      history: cliCommand({
        summary: "Show document revision history",
        positionals: [
          {
            name: "agent",
            description: "Agent UUID, @slug, or unique name",
            required: true,
          },
          {
            name: "file",
            description: "MISSION.md or PERSONA.md",
            required: true,
          },
        ],
        options: {
          before: {
            type: "integer",
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
            description: "Return revisions older than this revision ID",
            placeholder: "N",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          const profile = ownAgent(positionals.agent, ctx);
          const parsed = agentDocumentFileSchema.safeParse(positionals.file);
          if (!parsed.success) {
            throw new PluginCliError("File must be MISSION.md or PERSONA.md.", {
              code: "invalid_document",
            });
          }
          const revisions = await attempt(() => profiles.homes.documentHistory(
            profile,
            parsed.data,
            options.before,
          ));
          const human = revisions.map((revision) => [
            `${revision.id}\t${new Date(revision.createdAt).toISOString()}\t${revision.actor}`,
            revision.text,
          ].join("\n")).join("\n---\n");
          return success(revisions, human || "No revisions.", options.json);
        },
      }),
      "thread members": cliCommand({
        summary: "List agents joined to a normal thread",
        positionals: [{
          name: "thread-id",
          description: "Parent thread ID",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }) {
          return attempt(async () => {
            const members = await profiles.threadMemberStates(
              positionals["thread-id"],
            );
            const human = members.map((member) => {
              const child = member.childThreadId
                ? `${member.childThreadId}  ${member.visibility}`
                : "no child";
              return `@${member.slug}  ${member.name}  ${member.status}  ${child}`;
            }).join("\n");
            return output(members, options.json, human || "No joined agents.");
          });
        },
      }),
      "thread remove": cliCommand({
        summary: "Remove one agent from a normal thread",
        positionals: [
          {
            name: "thread-id",
            description: "Parent thread ID",
            required: true,
          },
          {
            name: "agent",
            description: "Agent UUID, @slug, or unique name",
            required: true,
          },
        ],
        options: jsonOption,
        async run({ positionals, options }) {
          return attempt(async () => {
            const profile = resolveAgent(profiles, positionals.agent);
            await profiles.removeThreadMember(
              positionals["thread-id"],
              profile.id,
            );
            const result = {
              threadId: positionals["thread-id"],
              profileId: profile.id,
              removed: true,
            };
            return output(
              result,
              options.json,
              `Removed @${profile.slug} from ${positionals["thread-id"]}.`,
            );
          });
        },
      }),
      "thread promote": cliCommand({
        summary: "Promote a delegated child into the visible thread list",
        positionals: [{
          name: "child-thread-id",
          description: "Delegated child thread ID",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }) {
          return attempt(async () => {
            const binding = profiles.delegationBindingForChild(
              positionals["child-thread-id"],
            );
            await profiles.promoteDelegation(
              binding.threadId,
              binding.parentThreadId,
            );
            const result = {
              childThreadId: binding.threadId,
              parentThreadId: binding.parentThreadId,
              promoted: true,
            };
            return output(
              result,
              options.json,
              `Promoted ${binding.threadId}.`,
            );
          });
        },
      }),
      ask: cliCommand({
        summary: "Start a hidden task thread for an agent",
        description: "The thread keeps the agent's identity and long memory. Send follow-ups with `bb thread tell`.",
        positionals: [{ name: "agent", description: "Agent UUID, @slug, or unique name", required: true }],
        options: {
          ...jsonOption,
          text: { type: "string", description: "The request", required: true, placeholder: "TEXT" },
          title: { type: "string", description: "Thread title", placeholder: "TITLE" },
          project: { type: "string", description: "Project ID; defaults to the agent's fixed project", placeholder: "PROJECT" },
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            // Agents delegate through their own tool, which records the parent thread.
            if (caller(ctx)?.agentId)
              throw new PluginCliError("Agents delegate with the delegation tool.", { code: "agent_access_denied" });
            const profile = resolveAgent(profiles, positionals.agent);
            const result = await profiles.spawnProfile({
              profileId: profile.id,
              ...(options.project ? { projectId: options.project, environment: { type: "project-default" as const } } : {}),
              title: options.title ?? options.text.slice(0, 80),
              prompt: options.text,
              visibility: "hidden",
            });
            return success(result, `Started ${result.threadId} for @${profile.slug}.`, options.json);
          });
        },
      }),
      "channel list": cliCommand({
        summary: "List channels",
        options: {
          archived: {
            type: "boolean",
            description: "List archived channels instead of active channels",
          },
          all: {
            type: "boolean",
            description: "List active and archived channels",
          },
          limit: {
            type: "integer",
            min: 1,
            max: 100,
            default: 50,
            description: "Maximum channels to return",
          },
          offset: {
            type: "integer",
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            default: 0,
            description: "Skip this many matching channels",
          },
          ...jsonOption,
        },
        constraints: [{ kind: "at-most-one", options: ["archived", "all"] }],
        async run({ options }, ctx) {
          return attempt(async () => {
            const author = caller(ctx);
            const matching = store.rooms()
              .filter((room) =>
                !author?.agentId || room.memberIds.includes(author.agentId)
              )
              .filter((room) =>
                options.all || Boolean(room.archived) === options.archived
              );
            const channels = matching.slice(
              options.offset,
              options.offset + options.limit,
            );
            const data = {
              channels,
              offset: options.offset,
              nextOffset: matching.length > options.offset + options.limit
                ? options.offset + options.limit
                : null,
            };
            const human = [
              ...channels.map((room) =>
                `${room.id}  ${room.name}  ${room.memberIds.length} agents${
                  room.archived ? "  archived" : ""
                }`
              ),
              ...(data.nextOffset === null
                ? []
                : [`More: --offset ${data.nextOffset}`]),
            ].join("\n");
            return output(data, options.json, human || "No channels.");
          });
        },
      }),
      "channel create": cliCommand({
        summary: "Create an empty or populated channel",
        positionals: [{
          name: "name",
          description: "Channel name; defaults to New channel",
        }],
        options: {
          agent: {
            type: "string",
            repeatable: true,
            description: "Agent UUID, @slug, or unique name; repeat up to 16 times",
            placeholder: "AGENT",
          },
          mode: {
            type: "enum",
            values: ["directed", "automatic", "smart"],
            description:
              "Response mode: Automatic chooses one agent; smart is an alias",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            await store.ensureProject();
            const selected = options.agent.map((selector) =>
              resolveAgent(profiles, selector).id
            );
            const memberIds = ctx.threadId
              ? creatorMembers(store, ctx.threadId, selected)
              : selected;
            const responseBehavior =
              options.mode === "automatic" ? "smart" : options.mode;
            const room = await call("createRoom", {
              name: positionals.name,
              memberIds,
              responseBehavior,
            });
            return output(room, options.json);
          });
        },
      }),
      "channel show": cliCommand({
        summary: "Show channel settings and membership",
        positionals: [{
          name: "channel",
          description: "Channel UUID or exact name",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(() =>
            output(channel(positionals.channel, ctx), options.json)
          );
        },
      }),
      "channel invite": cliCommand({
        summary: "Invite one agent",
        positionals: [
          {
            name: "channel",
            description: "Channel UUID or exact name",
            required: true,
          },
          {
            name: "agent",
            description: "Agent UUID, @slug, or unique name",
            required: true,
          },
        ],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            requireChannelOwner(ctx);
            const result = await call("member", {
              id: room.id,
              agentId: resolveAgent(profiles, positionals.agent).id,
              present: true,
            });
            return output(result, options.json);
          });
        },
      }),
      "channel remove": cliCommand({
        summary: "Remove one agent and cancel its unfinished channel work",
        positionals: [
          {
            name: "channel",
            description: "Channel UUID or exact name",
            required: true,
          },
          {
            name: "agent",
            description: "Agent UUID, @slug, or unique name",
            required: true,
          },
        ],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            requireChannelOwner(ctx);
            const result = await call("member", {
              id: room.id,
              agentId: resolveAgent(profiles, positionals.agent).id,
              present: false,
            });
            return output(result, options.json);
          });
        },
      }),
      "channel send": cliCommand({
        summary: "Send a message or reply",
        positionals: [{
          name: "channel",
          description: "Channel UUID or exact name",
          required: true,
        }],
        options: {
          text: {
            type: "string",
            required: true,
            stdin: true,
            description: "Message text, up to 16,000 characters",
            placeholder: "TEXT",
          },
          attach: {
            type: "string",
            repeatable: true,
            description: "Attach a file, up to 8 MB; repeat up to 10 times",
            placeholder: "PATH",
          },
          "reply-to": {
            type: "string",
            description: "Message ID to reply to",
            placeholder: "ID",
          },
          "request-id": {
            type: "string",
            description: "UUID reused after an uncertain send",
            placeholder: "UUID",
          },
          mode: {
            type: "enum",
            values: ["auto", "steer", "followup", "fork"],
            default: "auto",
            description:
              "Delivery mode: queue automatically, steer now, follow up, or answer in parallel",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            if (options.attach.length > 10) {
              throw new PluginCliError("Attach at most 10 files.", {
                code: "too_many_attachments",
              });
            }
            const attachmentIds: string[] = [];
            for (const path of options.attach) {
              const file = await readCliFile(bb, ctx, path, 8 * 1024 * 1024);
              const attachment = await call("upload", {
                id: room.id,
                name: file.name,
                mimeType: file.mimeType,
                data: file.bytes.toString("base64"),
              });
              attachmentIds.push(attachment.id);
            }
            const input = rpcContract.send.input.parse({
              id: room.id,
              text: options.text,
              attachmentIds,
              replyTo: options["reply-to"],
              requestId: options["request-id"] ?? randomUUID(),
              sendMode: options.mode,
            });
            const message = rpcContract.send.output.parse(
              await sendMessage(input, ctx.threadId),
            );
            return output(message, options.json);
          });
        },
      }),
      "channel messages": cliCommand({
        summary: "Read messages and reactions, newest page first",
        positionals: [{
          name: "channel",
          description: "Channel UUID or exact name",
          required: true,
        }],
        options: {
          limit: {
            type: "integer",
            min: 1,
            max: 50,
            default: 20,
            description: "Maximum messages to return",
          },
          offset: {
            type: "integer",
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            default: 0,
            description: "Skip this many newest messages",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(() => {
            const room = channel(positionals.channel, ctx);
            const messages = store.visibleMessages(
              room.id,
              options.limit,
              options.offset,
            );
            const ids = new Set(messages.map((message) => message.id));
            return output({
              messages,
              reactions: store.reactions(room.id).filter((reaction) =>
                ids.has(reaction.messageId)
              ),
              offset: options.offset,
              nextOffset: messages.length === options.limit
                ? options.offset + options.limit
                : null,
            }, options.json);
          });
        },
      }),
      "channel search": cliCommand({
        summary: "Search channel history",
        positionals: [
          {
            name: "channel",
            description: "Channel UUID or exact name",
            required: true,
          },
          {
            name: "query",
            description: "Text or speaker name to find",
            required: true,
          },
        ],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            return output(await call("history", {
              id: room.id,
              query: positionals.query,
              limit: 50,
            }), options.json);
          });
        },
      }),
      "channel react": cliCommand({
        summary: "Add or remove your emoji reaction",
        positionals: [
          {
            name: "channel",
            description: "Channel UUID or exact name",
            required: true,
          },
          {
            name: "message-id",
            description: "Message ID",
            required: true,
          },
          {
            name: "emoji",
            description: "One emoji",
            required: true,
          },
        ],
        options: {
          remove: {
            type: "boolean",
            description: "Remove the reaction instead of adding it",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            const input = rpcContract.reaction.input.parse({
              id: room.id,
              messageId: positionals["message-id"],
              emoji: positionals.emoji,
              active: !options.remove,
            });
            if (ctx.threadId) {
              rpcContract.reaction.output.parse(
                channelReaction(store, ctx.threadId, input),
              );
              bb.realtime.publish("changed", {});
            } else {
              await call("reaction", input);
            }
            return output({
              messageId: positionals["message-id"],
              emoji: positionals.emoji,
              active: !options.remove,
            }, options.json);
          });
        },
      }),
      "channel archive": cliCommand({
        summary: "Archive a channel and preserve history",
        positionals: [{
          name: "channel",
          description: "Channel UUID or exact name",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            requireChannelOwner(ctx);
            return output(
              await call("channelState", { id: room.id, archived: true }),
              options.json,
            );
          });
        },
      }),
      "channel restore": cliCommand({
        summary: "Restore an archived channel",
        positionals: [{
          name: "channel",
          description: "Channel UUID or exact name",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            requireChannelOwner(ctx);
            return output(
              await call("channelState", { id: room.id, archived: false }),
              options.json,
            );
          });
        },
      }),
      "channel delete": cliCommand({
        summary: "Permanently delete a channel and its history",
        positionals: [{
          name: "channel",
          description: "Channel UUID or exact name",
          required: true,
        }],
        options: {
          yes: {
            type: "boolean",
            description: "Confirm permanent deletion",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            requireChannelOwner(ctx);
            if (!options.yes) {
              throw new PluginCliError(
                "Deleting a channel permanently removes its history. Pass --yes to confirm, or use channel archive to preserve it.",
                { code: "confirmation_required" },
              );
            }
            return output(
              await call("deleteRoom", { id: room.id }),
              options.json,
            );
          });
        },
      }),
      activity: cliCommand({
        summary: "List work and response IDs",
        options: {
          agent: {
            type: "string",
            description: "Filter by agent UUID, @slug, or unique name",
            placeholder: "AGENT",
          },
          channel: {
            type: "string",
            description: "Filter by channel UUID or exact name",
            placeholder: "CHANNEL",
          },
          limit: {
            type: "integer",
            min: 1,
            max: 50,
            default: 20,
            description: "Maximum work items to return",
          },
          offset: {
            type: "integer",
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            default: 0,
            description: "Skip this many newest work items",
          },
          ...jsonOption,
        },
        async run({ options }, ctx) {
          return attempt(() => {
            const author = caller(ctx);
            const agentId = options.agent
              ? ownAgent(options.agent, ctx).id
              : (author?.agentId ?? undefined);
            const roomId = options.channel
              ? channel(options.channel, ctx).id
              : undefined;
            const jobs = store.activity(
              agentId,
              roomId,
              options.limit,
              options.offset,
            );
            return output({
              jobs,
              offset: options.offset,
              nextOffset: jobs.length === options.limit
                ? options.offset + options.limit
                : null,
            }, options.json);
          });
        },
      }),
      job: cliCommand({
        summary: "Show one work item, output, and BB thread ID",
        positionals: [{
          name: "id",
          description: "Work item ID",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(() =>
            output(ownJob(positionals.id, ctx), options.json)
          );
        },
      }),
      stop: cliCommand({
        summary: "Stop one channel response",
        positionals: [{
          name: "job-id",
          description: "Work item ID",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const job = ownJob(positionals["job-id"], ctx);
            return output(
              await call("cancelJob", { id: job.id }),
              options.json,
            );
          });
        },
      }),
      retry: cliCommand({
        summary: "Retry one failed or stopped channel response",
        positionals: [{
          name: "job-id",
          description: "Work item ID",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const job = ownJob(positionals["job-id"], ctx);
            return output(
              await call("retryJob", { id: job.id }),
              options.json,
            );
          });
        },
      }),
      steer: cliCommand({
        summary: "Send one queued channel response into the running turn",
        positionals: [{
          name: "job-id",
          description: "Queued work item ID",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const job = ownJob(positionals["job-id"], ctx);
            return output(
              await call("queuedJobAction", {
                jobId: job.id,
                action: "steer",
              }),
              options.json,
            );
          });
        },
      }),
      fork: cliCommand({
        summary: "Answer one queued channel response in parallel",
        positionals: [{
          name: "job-id",
          description: "Queued work item ID",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const job = ownJob(positionals["job-id"], ctx);
            return output(
              await call("queuedJobAction", {
                jobId: job.id,
                action: "fork",
              }),
              options.json,
            );
          });
        },
      }),
      "automation list": cliCommand({
        summary: "List scheduled channel work",
        positionals: [{
          name: "channel",
          description: "Channel UUID or exact name",
          required: true,
        }],
        options: {
          limit: {
            type: "integer",
            min: 1,
            max: 50,
            default: 20,
            description: "Maximum automations to return",
          },
          offset: {
            type: "integer",
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            default: 0,
            description: "Skip this many channel automations",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            const result = await automations.list(
              channelAutomationListSchema.parse({
                channelId: room.id,
                limit: options.limit,
                offset: options.offset,
              }),
              ctx.threadId,
            );
            const human = result.automations.map((automation) =>
              `${automation.id}  ${automation.enabled ? "enabled" : "paused"}  @${store.get(automation.agentId).handle}  ${automation.name}  ${automationScheduleLabel(automation)}`
            ).join("\n");
            return output(result, options.json, human || "No automations.");
          });
        },
      }),
      "automation create": cliCommand({
        summary: "Create scheduled channel work",
        positionals: [{
          name: "channel",
          description: "Channel UUID or exact name",
          required: true,
        }],
        options: {
          agent: {
            type: "string",
            required: true,
            description: "Agent UUID, @slug, or unique name",
            placeholder: "AGENT",
          },
          name: {
            type: "string",
            required: true,
            description: "Short automation title",
            placeholder: "NAME",
          },
          text: {
            type: "string",
            required: true,
            stdin: true,
            description: "Task prompt",
            placeholder: "TEXT",
          },
          at: {
            type: "string",
            description: "One-time ISO date and time",
            placeholder: "ISO_TIME",
          },
          cron: {
            type: "string",
            description: "Five-field cron expression",
            placeholder: "EXPR",
          },
          timezone: {
            type: "string",
            description: "IANA timezone for --cron",
            placeholder: "ZONE",
          },
          enabled: {
            type: "boolean",
            description: "Enable immediately; new CLI schedules are paused by default",
          },
          "request-id": {
            type: "string",
            description: "UUID for safe retries",
            placeholder: "UUID",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            const result = await automations.create(
              channelAutomationCreateSchema.parse({
                channelId: room.id,
                agentId: resolveAgent(profiles, options.agent).id,
                name: options.name,
                prompt: options.text,
                trigger: automationTrigger(options, true),
                enabled: options.enabled,
                requestId: options["request-id"] ?? randomUUID(),
              }),
              ctx.threadId,
            );
            return output(
              result,
              options.json,
              `Created ${result.id} (${result.enabled ? "enabled" : "paused"}).`,
            );
          });
        },
      }),
      "automation update": cliCommand({
        summary: "Update scheduled channel work",
        positionals: [
          {
            name: "channel",
            description: "Channel UUID or exact name",
            required: true,
          },
          {
            name: "automation-id",
            description: "Automation ID",
            required: true,
          },
        ],
        options: {
          name: {
            type: "string",
            description: "Replacement title",
            placeholder: "NAME",
          },
          text: {
            type: "string",
            stdin: true,
            description: "Replacement task prompt",
            placeholder: "TEXT",
          },
          at: {
            type: "string",
            description: "Replacement one-time ISO date and time",
            placeholder: "ISO_TIME",
          },
          cron: {
            type: "string",
            description: "Replacement five-field cron expression",
            placeholder: "EXPR",
          },
          timezone: {
            type: "string",
            description: "IANA timezone for --cron",
            placeholder: "ZONE",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            const trigger = automationTrigger(options, false);
            const result = await automations.update(
              channelAutomationUpdateSchema.parse({
                channelId: room.id,
                automationId: positionals["automation-id"],
                ...(options.name !== undefined ? { name: options.name } : {}),
                ...(options.text !== undefined
                  ? { prompt: options.text }
                  : {}),
                ...(trigger ? { trigger } : {}),
              }),
              ctx.threadId,
            );
            return output(result, options.json, `Updated ${result.id}.`);
          });
        },
      }),
      "automation pause": cliCommand({
        summary: "Pause scheduled channel work",
        positionals: [
          {
            name: "channel",
            description: "Channel UUID or exact name",
            required: true,
          },
          {
            name: "automation-id",
            description: "Automation ID",
            required: true,
          },
        ],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            const result = await automations.pause(
              channelAutomationTargetSchema.parse({
                channelId: room.id,
                automationId: positionals["automation-id"],
              }),
              ctx.threadId,
            );
            return output(result, options.json, "Automation paused.");
          });
        },
      }),
      "automation resume": cliCommand({
        summary: "Resume scheduled channel work",
        positionals: [
          {
            name: "channel",
            description: "Channel UUID or exact name",
            required: true,
          },
          {
            name: "automation-id",
            description: "Automation ID",
            required: true,
          },
        ],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            const result = await automations.resume(
              channelAutomationTargetSchema.parse({
                channelId: room.id,
                automationId: positionals["automation-id"],
              }),
              ctx.threadId,
            );
            return output(result, options.json, "Automation resumed.");
          });
        },
      }),
      "automation run": cliCommand({
        summary: "Run scheduled channel work now",
        positionals: [
          {
            name: "channel",
            description: "Channel UUID or exact name",
            required: true,
          },
          {
            name: "automation-id",
            description: "Automation ID",
            required: true,
          },
        ],
        options: {
          "request-id": {
            type: "string",
            description: "UUID for safe retries",
            placeholder: "UUID",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const room = channel(positionals.channel, ctx);
            const result = await automations.run(
              channelAutomationRunSchema.parse({
                channelId: room.id,
                automationId: positionals["automation-id"],
                requestId: options["request-id"] ?? randomUUID(),
              }),
              ctx.threadId,
            );
            return output(
              result,
              options.json,
              `Run requested${result.runId ? `: ${result.runId}` : "."}`,
            );
          });
        },
      }),
      "automation delete": cliCommand({
        summary: "Delete scheduled channel work",
        positionals: [
          {
            name: "channel",
            description: "Channel UUID or exact name",
            required: true,
          },
          {
            name: "automation-id",
            description: "Automation ID",
            required: true,
          },
        ],
        options: {
          yes: {
            type: "boolean",
            description: "Confirm permanent deletion",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            if (!options.yes) {
              throw new PluginCliError(
                "Deleting an automation requires --yes.",
                { code: "confirmation_required" },
              );
            }
            const room = channel(positionals.channel, ctx);
            const result = await automations.delete(
              channelAutomationTargetSchema.parse({
                channelId: room.id,
                automationId: positionals["automation-id"],
              }),
              ctx.threadId,
            );
            return output(result, options.json, "Automation deleted.");
          });
        },
      }),
      "automation fire": cliCommand({
        summary: "Dispatch one active automation run",
        positionals: [{
          name: "automation-id",
          description: "Automation ID supplied by the runner",
          required: true,
        }],
        options: {
          project: {
            type: "string",
            required: true,
            description: "Automation project ID",
            placeholder: "ID",
          },
          run: {
            type: "string",
            required: true,
            description: "Active automation run ID",
            placeholder: "ID",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const result = await automations.fire(
              options.project,
              positionals["automation-id"],
              options.run,
              ctx.threadId,
              ctx.signal,
            );
            return output(result, options.json);
          });
        },
      }),
      schedule: cliCommand({
        summary: "Set an agent mission schedule",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: {
          every: {
            type: "string",
            required: true,
            description: "Wake interval (30m, 1h, 4h, 1d) or off; range 15m to 1w",
            placeholder: "DURATION",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            const agent = await call("setMissionSchedule", {
              id: ownAgent(positionals.agent, ctx).id,
              intervalMinutes: scheduleInterval(options.every),
            });
            return output(
              agent,
              options.json,
              `Mission schedule for @${agent.handle}: ${scheduleLabel(agent.intervalMinutes)}\n${nextWakeLabel(agent.nextWakeAt, agent.paused, agent.retired)}`,
            );
          });
        },
      }),
      wake: cliCommand({
        summary: "Queue one mission turn for an agent",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () =>
            output(
              await call("wake", { id: ownAgent(positionals.agent, ctx).id }),
              options.json,
            )
          );
        },
      }),
      pause: cliCommand({
        summary: "Pause standalone mission work; channel replies remain available",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () =>
            output(
              await call("pause", {
                id: ownAgent(positionals.agent, ctx).id,
                paused: true,
              }),
              options.json,
            )
          );
        },
      }),
      resume: cliCommand({
        summary: "Resume standalone mission work",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () =>
            output(
              await call("pause", {
                id: ownAgent(positionals.agent, ctx).id,
                paused: false,
              }),
              options.json,
            )
          );
        },
      }),
      retire: cliCommand({
        summary: "Retire an agent, stop its work, and preserve its history",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () =>
            output(
              await call("retire", {
                id: ownAgent(positionals.agent, ctx).id,
                retired: true,
              }),
              options.json,
            )
          );
        },
      }),
      restore: cliCommand({
        summary: "Restore a retired agent with mission work paused",
        positionals: [{
          name: "agent",
          description: "Agent UUID, @slug, or unique name",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          return attempt(async () =>
            output(
              await call("retire", {
                id: ownAgent(positionals.agent, ctx).id,
                retired: false,
              }),
              options.json,
            )
          );
        },
      }),
      "publish-image": cliCommand({
        summary: "Embed a local image in your active agent response",
        positionals: [{
          name: "path",
          description: "Absolute path inside the active agent home",
          required: true,
        }],
        options: {
          alt: {
            type: "string",
            description: "Alternative text, up to 500 characters",
            placeholder: "TEXT",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            if (!ctx.threadId) {
              throw new PluginCliError(
                "Run this command from an active agent channel response.",
                { code: "active_response_required" },
              );
            }
            return output(
              await publishImage(ctx.threadId, positionals.path, options.alt),
              options.json,
            );
          });
        },
      }),
      "publish-file": cliCommand({
        summary: "Attach a local file to your active agent response",
        positionals: [{
          name: "path",
          description: "Absolute path inside the active agent home",
          required: true,
        }],
        options: {
          alt: {
            type: "string",
            description: "Alternative text, up to 500 characters",
            placeholder: "TEXT",
          },
          ...jsonOption,
        },
        async run({ positionals, options }, ctx) {
          return attempt(async () => {
            if (!ctx.threadId) {
              throw new PluginCliError(
                "Run this command from an active agent channel response.",
                { code: "active_response_required" },
              );
            }
            return output(
              await publishFile(ctx.threadId, positionals.path, options.alt),
              options.json,
            );
          });
        },
      }),
      export: cliCommand({
        summary: "Export agents as JSON",
        options: jsonOption,
        async run({ options }) {
          const data = await attempt(() => profiles.exportProfiles());
          return success(data, JSON.stringify(data, null, 2), options.json);
        },
      }),
      import: cliCommand({
        summary: "Import agents from JSON",
        positionals: [{
          name: "file",
          description: "JSON export path",
          required: true,
        }],
        options: jsonOption,
        async run({ positionals, options }, ctx) {
          const result = await attempt(async () => {
            const text = await readTextFile(bb, ctx, positionals.file, 1_048_576);
            return profiles.importProfiles(exportSchema.parse(JSON.parse(text)));
          });
          return success(result, `Imported ${result.imported} profile(s).`, options.json);
        },
      }),
    },
  }));
}
