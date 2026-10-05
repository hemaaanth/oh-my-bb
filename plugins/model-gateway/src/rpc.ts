// Ported from the core Account Pooler (account-pool), MIT, Michael Yong 2026.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  accountAddInputSchema,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  accountIdInputSchema,
  accountPriorityInputSchema,
  accountReorderInputSchema,
  accountSchema,
  accountSummarySchema,
  bypassInputSchema,
  bypassResultSchema,
  codexLoginCancelSchema,
  codexLoginPollInputSchema,
  codexLoginPollSchema,
  codexLoginStartSchema,
  hubTokenSummarySchema,
  keyAddInputSchema,
  loginCompleteInputSchema,
  loginStartSchema,
  statusSchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  routingTargetSchema,
  type AccountPoolConfigController,
  type KeyAddInput,
  type RoutingTarget,
} from "./contracts.js";

import {
  autoLadder,
  chainEntryOptions,
  entryTitle,
  chainEntrySchema,
  harnessSchema,
  modelMapKeySchema,
  upstreamKind,
  upstreamKindSchema,
  type Harness,
} from "./chain.js";
import { ACCOUNT_POOL_BLOCKED_STATUS_MESSAGE } from "./coexistence.js";
import {
  setAuto,
  setChain,
  setModelMapEntry,
  type PoolOperations,
} from "./operations.js";
import { setupGuides } from "./setup.js";
import type { ClaudeOAuthLogin } from "./upstreams/oauth-login.js";
import type { CodexDeviceLogin } from "./upstreams/codex-device-login.js";

const fallbackCauseRpcSchema = z
  .object({
    upstreamId: z.string(),
    upstreamLabel: z.string(),
    category: z.enum(["transport", "authentication", "rate-limit", "availability"]),
    status: z.number().int(),
    message: z.string(),
    at: z.number().int(),
  })
  .strict();

export const accountPoolRpcContract = defineRpcContract({
  "account.add": {
    input: accountAddInputSchema,
    output: accountSchema,
  },
  "account.list": {
    input: z.null(),
    output: z.array(accountSummarySchema),
  },
  "account.remove": {
    input: accountIdInputSchema,
    output: z.object({ removed: z.boolean() }).strict(),
  },
  "account.enable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.disable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.setPriority": {
    input: accountPriorityInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.reorder": {
    input: accountReorderInputSchema,
    output: z.null(),
  },
  "account.refreshUsage": {
    input: z.object({ accountId: z.string().uuid() }).strict(),
    output: z.object({ account: accountSummarySchema.nullable() }).strict(),
  },
  "routing.set": {
    input: routingSetInputSchema,
    output: z
      .object({ provider: routingTargetSchema, enabled: z.boolean() })
      .strict(),
  },
  "routing.get": {
    input: z.null(),
    output: z
      .object({
        enabled: z.record(routingTargetSchema, z.boolean()),
        /** Set while the core Account Pooler is enabled: the gateway routes nothing. */
        blockedBy: z.string().nullable(),
        /** One-time setup per ACP or Pi harness. Shown, never run. */
        setup: z.record(z.enum(["acp-omp", "acp-fx", "acp-nanocodex", "pi"]), z.string()),
        /** Models Jev auto picks among, per harness, cheapest first. */
        ladders: z.record(harnessSchema, z.array(z.string())),
      })
      .strict(),
  },
  "key.add": {
    input: keyAddInputSchema,
    output: accountSchema,
  },
  "chain.options": {
    input: z.null(),
    output: z.record(
      harnessSchema,
      z.array(
        z
          .object({
            entry: z.string(),
            label: z.string(),
            /** Why the legal guard refuses this entry for the harness; null when legal. */
            blocked: z.string().nullable(),
          })
          .strict(),
      ),
    ),
  },
  "chain.set": {
    input: z
      .object({ harness: harnessSchema, entries: z.array(chainEntrySchema).min(1) })
      .strict(),
    output: accountPoolConfigSchema,
  },
  "modelMap.set": {
    input: z
      .object({
        key: modelMapKeySchema,
        pattern: z.string().min(1),
        /** Null removes the row. */
        model: z.string().min(1).nullable(),
      })
      .strict(),
    output: accountPoolConfigSchema,
  },
  "auto.set": {
    input: z
      .object({
        harness: harnessSchema.optional(),
        off: z.boolean().optional(),
        key: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      })
      .strict(),
    output: accountPoolConfigSchema,
  },
  "live.get": {
    input: z.null(),
    output: z
      .object({
        /** Recent threads on a fallback entry or a Jev pick. */
        threads: z.array(
          z
            .object({
              threadId: z.string(),
              harness: harnessSchema,
              entryIndex: z.number().int(),
              entry: z.string().nullable(),
              upstreamKind: upstreamKindSchema.nullable(),
              upstreamLabel: z.string().nullable(),
              model: z.string().nullable(),
              autoModel: z.string().nullable(),
              autoReason: z.string().nullable(),
              stickyUntil: z.number().int().nullable(),
              fallbackCause: fallbackCauseRpcSchema.nullable(),
              usedAt: z.number().int(),
            })
            .strict(),
        ),
        holds: z.array(
          z
            .object({
              accountId: z.string(),
              label: z.string(),
              upstreamKind: upstreamKindSchema,
              until: z.number().int(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  "hold.clear": {
    input: z.object({ accountId: z.string().uuid() }).strict(),
    output: z.object({ cleared: z.boolean() }).strict(),
  },
  "config.get": {
    input: z.null(),
    output: accountPoolConfigSchema,
  },
  "config.set": {
    input: accountPoolConfigSetInputSchema,
    output: accountPoolConfigSchema,
  },
  "login.start": {
    input: z.null(),
    output: loginStartSchema,
  },
  "login.complete": {
    input: loginCompleteInputSchema,
    output: accountSchema,
  },
  "codexLogin.start": {
    input: z.null(),
    output: codexLoginStartSchema,
  },
  "codexLogin.poll": {
    input: codexLoginPollInputSchema,
    output: codexLoginPollSchema,
  },
  "codexLogin.cancel": {
    input: codexLoginPollInputSchema,
    output: codexLoginCancelSchema,
  },
  "status.get": {
    input: z.null(),
    output: statusSchema,
  },
  "token.rotate": {
    input: tokenRotateInputSchema,
    output: hubTokenSummarySchema,
  },
  "bypass.set": {
    input: bypassInputSchema,
    output: bypassResultSchema,
  },
  "thread.route": {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        harness: harnessSchema,
        upstreamKind: upstreamKindSchema.nullable(),
        accountLabel: z.string().nullable(),
        model: z.string().nullable(),
        chainIndex: z.number().int(),
        /** The harness chain in plain names (`Claude Max → ChatGPT`). */
        chain: z.array(z.string()),
        stickyUntil: z.number().int().nullable(),
        /** P5: the model Jev auto picked, or null. */
        autoModel: z.string().nullable(),
        /** P5: why the model was chosen (`jev 0.82`, `fail open: timeout`); null when auto is off. */
        auto: z.string().nullable(),
        fallbackCause: fallbackCauseRpcSchema.nullable(),
      })
      .strict()
      .nullable(),
  },
});

export function createRpcHandlers(
  operations: PoolOperations,
  login: ClaudeOAuthLogin,
  codexLogin: CodexDeviceLogin,
  config: AccountPoolConfigController,
  host: {
    /** True while the core Account Pooler is enabled (coexistence.ts). */
    accountPoolRouting: () => Promise<boolean>;
    serverUrl: () => string;
  },
) {
  return {
    "account.add": (input: Parameters<PoolOperations["add"]>[0]) =>
      operations.add(input),
    "account.list": () => operations.list(),
    "account.remove": async ({ id }: { id: string }) => ({
      removed: await operations.remove(id),
    }),
    "account.enable": async ({ id }: { id: string }) => ({
      account: await operations.enable(id),
    }),
    "account.disable": async ({ id }: { id: string }) => ({
      account: await operations.disable(id),
    }),
    "account.setPriority": async ({
      accountId,
      priority,
    }: {
      accountId: string;
      priority: number;
    }) => ({
      account: await operations.setPriority(accountId, priority),
    }),
    "account.refreshUsage": async ({ accountId }: { accountId: string }) => ({
      account: await operations.refreshUsage(accountId),
    }),
    "account.reorder": async ({
      provider,
      accountIds,
    }: z.infer<typeof accountReorderInputSchema>) => {
      await operations.reorder(provider, accountIds);
      return null;
    },
    "routing.set": async ({
      provider,
      enabled,
    }: {
      provider: RoutingTarget;
      enabled: boolean;
    }) => {
      await operations.setRouting(provider, enabled);
      return { provider, enabled };
    },
    "routing.get": async () => ({
      enabled: Object.fromEntries(
        await Promise.all(
          routingTargetSchema.options.map(
            async (target) =>
              [target, await operations.isRoutingEnabled(target)] as const,
          ),
        ),
      ) as Record<RoutingTarget, boolean>,
      blockedBy: (await host.accountPoolRouting())
        ? ACCOUNT_POOL_BLOCKED_STATUS_MESSAGE
        : null,
      setup: setupGuides(host.serverUrl()),
      ladders: Object.fromEntries(
        harnessSchema.options.map((harness) => [
          harness,
          autoLadder(harness, config.get().modelMap),
        ]),
      ) as Record<Harness, string[]>,
    }),
    // The key is write-only: operations.addKey stores it and returns the
    // account row, which has no secret field.
    "key.add": (input: KeyAddInput) => operations.addKey(input),
    "chain.options": async () =>
      chainEntryOptions(config.get().chains, await operations.list()),
    "chain.set": ({ harness, entries }: { harness: Harness; entries: string[] }) =>
      setChain(config, harness, entries),
    "modelMap.set": ({
      key,
      pattern,
      model,
    }: {
      key: string;
      pattern: string;
      model: string | null;
    }) => setModelMapEntry(config, key, pattern, model),
    "auto.set": async (change: {
      harness?: Harness;
      off?: boolean;
      key?: string;
      model?: string;
    }) => setAuto(config, await operations.list(), change),
    "live.get": async () => ({
      threads: (await operations.notableRoutes()).map((route) => ({
        threadId: route.threadId,
        harness: route.harness,
        entryIndex: route.entryIndex,
        entry: route.entry,
        upstreamKind: route.upstreamKind,
        upstreamLabel: route.upstreamLabel,
        model: route.model,
        autoModel: route.autoModel,
        autoReason: route.autoReason,
        stickyUntil: route.stickyUntil,
        fallbackCause: route.fallbackCause,
        usedAt: route.usedAt,
      })),
      holds: (await operations.holds()).map(({ account, until }) => ({
        accountId: account.id,
        label: account.label,
        upstreamKind: upstreamKind(account),
        until,
      })),
    }),
    "hold.clear": async ({ accountId }: { accountId: string }) => ({
      cleared: (await operations.holdAccount(accountId, null)) !== null,
    }),
    "config.get": () => config.get(),
    "config.set": (input: Parameters<AccountPoolConfigController["set"]>[0]) =>
      config.set(input),
    "login.start": () => login.start(),
    "login.complete": (input: { sessionId: string; pasted: string }) =>
      login.complete(input),
    "codexLogin.start": () => codexLogin.start(),
    "codexLogin.poll": (input: { sessionId: string }) => codexLogin.poll(input),
    "codexLogin.cancel": (input: { sessionId: string }) => ({
      cancelled: codexLogin.cancel(input),
    }),
    "status.get": () => operations.status(),
    "token.rotate": ({ machine }: { machine: string }) =>
      operations.rotateToken(machine),
    "bypass.set": ({
      threadId,
      bypassed,
    }: {
      threadId: string;
      bypassed: boolean;
    }) => operations.setBypass(threadId, bypassed),
    "thread.route": async ({ threadId }: { threadId: string }) => {
      const route = await operations.threadStatus(threadId);
      if (route === null) return null;
      const accounts = await operations.list();
      return {
        harness: route.harness,
        upstreamKind: route.upstreamKind,
        accountLabel: route.upstreamLabel,
        model: route.model,
        chainIndex: route.entryIndex,
        chain: config.get().chains[route.harness].map((entry) => entryTitle(entry, accounts)),
        stickyUntil: route.stickyUntil,
        autoModel: route.autoModel,
        auto: route.autoReason,
        fallbackCause: route.fallbackCause,
      };
    },
  };
}
