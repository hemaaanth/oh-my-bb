// Name resolvers for machines, providers, and models (SPEC §11.8), plus the
// routing target that scopes provider lookups. Owned by P1.
import type { ServerContext } from "../context.js";

type Sdk = ServerContext["bb"]["sdk"];
export type HostRow = Awaited<ReturnType<Sdk["hosts"]["list"]>>[number];
export type ProjectRow = Awaited<ReturnType<Sdk["projects"]["list"]>>[number];

/** Lower case with spaces, dashes, dots, slashes, and underscores removed. */
export const normaliseName = (value: string): string => value.toLowerCase().replace(/[\s\-_./:]+/g, "");
const tokensOf = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** The edit distance a name match may have. */
export const MAX_EDIT_DISTANCE = 2;

export type NameMatch<T> = { ok: true; item: T } | { ok: false; reason: "none" | "ambiguous"; choices: T[] };

/**
 * Match a spoken or typed name against items. Each item has several names
 * (id, label). Order: exact normalised match, then every query token found in
 * a name, then the closest name within a small edit distance.
 */
export function matchName<T>(query: string, items: readonly T[], namesOf: (item: T) => string[]): NameMatch<T> {
  const wanted = normaliseName(query);
  if (wanted === "") return { ok: false, reason: "none", choices: [...items] };
  const pick = (found: T[]): NameMatch<T> | null => {
    if (found.length === 1) return { ok: true, item: found[0]! };
    return found.length > 1 ? { ok: false, reason: "ambiguous", choices: found } : null;
  };

  const exact = pick(items.filter((item) => namesOf(item).some((name) => normaliseName(name) === wanted)));
  if (exact) return exact;

  const queryTokens = tokensOf(query);
  const byTokens = pick(
    items.filter((item) =>
      namesOf(item).some((name) => {
        const compact = normaliseName(name);
        return queryTokens.length > 0 && queryTokens.every((token) => compact.includes(token));
      }),
    ),
  );
  if (byTokens) return byTokens;

  const scored = items
    .map((item) => ({ item, distance: Math.min(...namesOf(item).map((name) => editDistance(normaliseName(name), wanted))) }))
    .filter((entry) => entry.distance <= MAX_EDIT_DISTANCE);
  if (scored.length === 0) return { ok: false, reason: "none", choices: [...items] };
  const best = Math.min(...scored.map((entry) => entry.distance));
  const closest = scored.filter((entry) => entry.distance === best).map((entry) => entry.item);
  return pick(closest)!;
}

const listNames = (names: string[]): string => (names.length === 0 ? "none" : names.join(", "));

// ---------------------------------------------------------------------------
// Machines

/** Host by id, then exact name (any case), then a unique name substring. */
export function resolveMachine(query: string, hosts: readonly HostRow[]): HostRow {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const byId = hosts.find((host) => host.id === trimmed);
  if (byId) return byId;
  const byName = hosts.filter((host) => host.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!;
  const bySubstring = byName.length > 1 ? byName : hosts.filter((host) => lower !== "" && host.name.toLowerCase().includes(lower));
  if (bySubstring.length === 1) return bySubstring[0]!;
  const connected = hosts.filter((host) => host.status === "connected").map((host) => host.name);
  const problem = bySubstring.length > 1 ? `"${trimmed}" matches more than one machine` : `No machine is named "${trimmed}"`;
  throw new Error(`${problem}. Connected machines: ${listNames(connected)}.`);
}

// ---------------------------------------------------------------------------
// Routing target (host → environment → project default host)

export type RoutingTarget =
  | { kind: "host"; hostId: string; projectId?: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "project"; hostId: string; projectId: string }
  | { kind: "none" };

export function defaultSourceHost(project: ProjectRow): string | null {
  const source = project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
  return source?.hostId ?? null;
}

/** Pick the scope that decides which providers and models are available. */
export function routingTarget(input: { hostId?: string | null; environmentId?: string | null; project?: ProjectRow | null }): RoutingTarget {
  if (input.hostId) return { kind: "host", hostId: input.hostId, ...(input.project ? { projectId: input.project.id } : {}) };
  if (input.environmentId) return { kind: "environment", environmentId: input.environmentId };
  const hostId = input.project ? defaultSourceHost(input.project) : null;
  if (input.project && hostId) return { kind: "project", hostId, projectId: input.project.id };
  return { kind: "none" };
}

export function describeTarget(target: RoutingTarget): string {
  switch (target.kind) {
    case "host":
      return "machine";
    case "environment":
      return "thread environment";
    case "project":
      return "project default machine";
    default:
      return "server default";
  }
}

// ---------------------------------------------------------------------------
// Providers and models

export type ModelEntry = { id: string; displayName: string; isDefault: boolean };
export type ProviderEntry = { id: string; displayName: string; models: ModelEntry[]; modelError?: string };

/** Providers with their models for a routing target. A provider whose models fail keeps an empty list. */
export async function providersFor(ctx: ServerContext, target: RoutingTarget, onlyProviderId?: string): Promise<ProviderEntry[]> {
  const sdk = ctx.bb.sdk;
  const scope =
    target.kind === "environment"
      ? { environmentId: target.environmentId }
      : target.kind === "host" || target.kind === "project"
        ? { hostId: target.hostId }
        : {};
  const providers = (await sdk.providers.list(scope)).filter(
    (provider) => provider.available && (!onlyProviderId || provider.id === onlyProviderId),
  );
  return Promise.all(
    providers.map(async (provider): Promise<ProviderEntry> => {
      try {
        const result =
          target.kind === "environment"
            ? await sdk.providers.models({ environmentId: target.environmentId, providerId: provider.id })
            : target.kind === "host" || target.kind === "project"
              ? await sdk.providers.models({
                  hostId: target.hostId,
                  providerId: provider.id,
                  ...("projectId" in target && target.projectId ? { projectId: target.projectId } : {}),
                })
              : await sdk.providers.models({ providerId: provider.id });
        const models = result.models.map((model) => ({ id: model.id, displayName: model.displayName, isDefault: model.isDefault }));
        return { id: provider.id, displayName: provider.displayName, models, ...(result.modelLoadError ? { modelError: String(result.modelLoadError) } : {}) };
      } catch (error) {
        return { id: provider.id, displayName: provider.displayName, models: [], modelError: error instanceof Error ? error.message : "models unavailable" };
      }
    }),
  );
}

export function resolveProvider(query: string, providers: readonly ProviderEntry[]): ProviderEntry {
  const match = matchName(query, providers, (provider) => [provider.id, provider.displayName]);
  if (match.ok) return match.item;
  const names = match.choices.map((provider) => provider.displayName);
  const problem = match.reason === "ambiguous" ? `"${query}" matches more than one provider` : `No provider is named "${query}"`;
  throw new Error(`${problem}. Choices: ${listNames(match.reason === "ambiguous" ? names : providers.map((p) => p.displayName))}.`);
}

/** Resolve a model name across the given providers. Ambiguity lists "Model (Provider)". */
export function resolveModel(query: string, providers: readonly ProviderEntry[]): { provider: ProviderEntry; model: ModelEntry } {
  const pairs = providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
  const match = matchName(query, pairs, (pair) => [pair.model.id, pair.model.displayName]);
  if (match.ok) return match.item;
  const label = (pair: (typeof pairs)[number]) => `${pair.model.displayName} (${pair.provider.displayName})`;
  if (match.reason === "ambiguous") {
    throw new Error(`"${query}" matches more than one model. Choices: ${listNames(match.choices.map(label))}.`);
  }
  const shown = pairs.slice(0, 20).map(label);
  throw new Error(`No model is named "${query}". Choices: ${listNames(shown)}${pairs.length > shown.length ? ", and more" : ""}.`);
}
