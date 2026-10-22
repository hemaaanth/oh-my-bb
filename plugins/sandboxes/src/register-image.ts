import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type * as DaytonaSdkModule from "@daytona/sdk";
import type * as ModalSdkModule from "modal";
import { z } from "zod";
import type {
  SandboxImageProvider,
  SandboxImageRegistryConfig,
  SandboxSettings,
} from "./config.js";
import type {
  DaytonaPlacement,
  DaytonaSandboxClass,
} from "./daytona-capacity.js";
import {
  DEFAULT_SANDBOX_SIZE_TIER,
  sizeTierUnits,
  type SandboxSizeTier,
} from "./size-tiers.js";

const MAX_STDERR_LENGTH = 32 * 1024;
const SNAPSHOT_TIMEOUT_SECONDS = 45 * 60;

const e2bBuildSchema = z.object({
  buildId: z.string().min(1),
  name: z.string().min(1),
  templateId: z.string().min(1),
});

export interface DaytonaImageTarget {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  sandboxClass: DaytonaSandboxClass;
}

/**
 * Snapshot resources are the immutable floor inherited by every sandbox.
 * Daytona does not accept resources when creating from a snapshot, and some
 * deployments do not expose resize even when their quota advertises it, so a
 * size is only reachable through a snapshot registered at that size. One
 * registration per tier keeps the image identical and lets projects choose.
 */
export function daytonaSnapshotResources(
  sandboxClass: DaytonaSandboxClass,
  tier: SandboxSizeTier = DEFAULT_SANDBOX_SIZE_TIER,
): { cpu: number; memory: number; disk: number } {
  if (sandboxClass === "windows") {
    throw new Error(
      "Daytona Windows snapshots must be captured from a Windows sandbox; they cannot be built from the shared Linux image",
    );
  }
  const units = sizeTierUnits(tier);
  return { cpu: units.cpu, memory: units.memoryGiB, disk: units.diskGiB };
}

export interface ModalImageTarget {
  tokenId: string;
  tokenSecret: string;
  appName: string;
}

export interface RegistryCredentials {
  username: string;
  password: string;
}
export interface SandboxImageRegistrationResult {
  name: string;
  placement: DaytonaPlacement | null;
}


function credentials(
  registry: SandboxImageRegistryConfig,
): RegistryCredentials | null {
  return registry.username === null || registry.token === null
    ? null
    : { username: registry.username, password: registry.token };
}

const DAYTONA_DEFAULT_API_URL = "https://app.daytona.io/api";
const daytonaRegistrySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  url: z.string(),
});

/**
 * Daytona pulls snapshot images with credentials held by the organization
 * rather than credentials passed per snapshot, so a private repository needs a
 * registry entry. The API owns that entry, so the plugin keeps it in sync
 * instead of asking anyone to visit a dashboard.
 */
export async function ensureDaytonaRegistry(input: {
  target: DaytonaImageTarget;
  reference: string;
  registry: RegistryCredentials;
  onLog?: (message: string) => void;
}): Promise<void> {
  const apiUrl = (input.target.apiUrl ?? DAYTONA_DEFAULT_API_URL).replace(
    /\/+$/u,
    "",
  );
  // OCI reference rules: the first path segment is a registry host only when it
  // looks like one. Anything else — including a bare `name@sha256:…`, whose
  // digest colon is not a port — is a Docker Hub repository.
  const segments = input.reference.split("/");
  const candidate = segments.length > 1 ? (segments[0] ?? "") : "";
  const host =
    candidate.includes(".") ||
    candidate.includes(":") ||
    candidate === "localhost"
      ? candidate
      : "docker.io";
  const name = `bb-sandbox-${host}`;
  const headers = {
    Authorization: `Bearer ${input.target.apiKey}`,
    "Content-Type": "application/json",
  };
  const listed = await fetch(`${apiUrl}/docker-registry`, { headers });
  if (!listed.ok) {
    throw new Error(
      `Could not list Daytona registries (HTTP ${listed.status}); the API key may lack registry access`,
    );
  }
  const existing = z
    .array(daytonaRegistrySchema)
    .parse(await listed.json())
    .find((registry) => registry.name === name || registry.url === host);
  const body = JSON.stringify({
    name,
    url: host,
    username: input.registry.username,
    password: input.registry.password,
  });
  const saved =
    existing === undefined
      ? await fetch(`${apiUrl}/docker-registry`, {
          method: "POST",
          headers,
          body,
        })
      : await fetch(
          `${apiUrl}/docker-registry/${encodeURIComponent(existing.id)}`,
          { method: "PATCH", headers, body },
        );
  if (!saved.ok) {
    throw new Error(
      `Could not save the ${host} registry on Daytona (HTTP ${saved.status})`,
    );
  }
  input.onLog?.(
    existing === undefined
      ? `Registered ${host} with Daytona as ${name}`
      : `Refreshed the ${host} credentials Daytona uses to pull`,
  );
}

export async function registerDaytonaSnapshot(input: {
  target: DaytonaImageTarget;
  name: string;
  reference: string;
  registry: SandboxImageRegistryConfig;
  /** Size to register at; M when absent, matching pre-tier snapshots. */
  sizeTier?: SandboxSizeTier;
  /** Region to register into; the configured target when absent. */
  regionId?: string;
  onLog?: (message: string) => void;
}): Promise<SandboxImageRegistrationResult> {
  // Load the CommonJS entry outside the TypeScript source loader. Jiti's ESM
  // interop changes the shape of the SDK's `debug` dependency during hot
  // reload and makes snapshot registration fail before it reaches Daytona.
  const { Daytona } = createRequire(import.meta.url)(
    "@daytona/sdk",
  ) as typeof DaytonaSdkModule;
  const registry = credentials(input.registry);
  if (registry !== null) {
    await ensureDaytonaRegistry({
      target: input.target,
      reference: input.reference,
      registry,
      onLog: input.onLog,
    });
  }
  const daytona = new Daytona({
    apiKey: input.target.apiKey,
    ...(input.target.apiUrl === undefined
      ? {}
      : { apiUrl: input.target.apiUrl }),
    ...(input.target.target === undefined
      ? {}
      : { target: input.target.target }),
  });
  const resources = daytonaSnapshotResources(
    input.target.sandboxClass,
    input.sizeTier ?? DEFAULT_SANDBOX_SIZE_TIER,
  );
  const regionId = input.regionId ?? input.target.target;
  const create = async () =>
    daytona.snapshot.create(
      {
        entrypoint: ["bb-sandbox-entrypoint"],
        image: input.reference,
        name: input.name,
        // Snapshot-backed sandboxes inherit this allocation: the tier the
        // snapshot is registered at is the size every sandbox from it gets.
        resources,
        ...(regionId === undefined ? {} : { regionId }),
        sandboxClass: input.target.sandboxClass,
      },
      {
        onLogs: (chunk) => input.onLog?.(chunk),
        timeout: SNAPSHOT_TIMEOUT_SECONDS,
      },
    );
  try {
    const snapshot = await create();
    return {
      name: snapshot.name,
      placement: {
        regionId: snapshot.regionIds?.[0] ?? regionId ?? "",
        sandboxClass: input.target.sandboxClass,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/already exists/iu.test(detail)) throw error;
    // Re-registering the reference that is already published is a retry, not a
    // conflict — a provider further down the list may have failed, or CI may
    // have been dispatched twice. Only the same image behind the same name is
    // safe to accept: a different image would silently leave every new sandbox
    // on the older build.
    const existing = await daytona.snapshot.get(input.name);
    const published = existing.imageName ?? "";
    if (published !== "" && published !== input.reference) {
      throw new Error(
        `Daytona snapshot ${input.name} already points at ${published}; publish a new version rather than rebinding this one`,
      );
    }
    input.onLog?.(`Snapshot ${input.name} already registered with this image`);
    return {
      name: existing.name,
      placement: {
        regionId: existing.regionIds?.[0] ?? regionId ?? "",
        sandboxClass: input.target.sandboxClass,
      },
    };
  }
}

export async function registerModalImage(input: {
  target: ModalImageTarget;
  name: string;
  reference: string;
  registry: SandboxImageRegistryConfig;
  onLog?: (message: string) => void;
}): Promise<string> {
  // Load Modal's CommonJS entry externally so its generated protobuf runtime
  // is not reinterpreted by the TypeScript source loader during hot reloads.
  const { ModalClient } = createRequire(import.meta.url)(
    "modal",
  ) as typeof ModalSdkModule;
  const client = new ModalClient({
    tokenId: input.target.tokenId,
    tokenSecret: input.target.tokenSecret,
  });
  const registry = credentials(input.registry);
  const secret =
    registry === null
      ? undefined
      : await client.secrets.fromObject({
          REGISTRY_USERNAME: registry.username,
          REGISTRY_PASSWORD: registry.password,
        });
  const app = await client.apps.fromName(input.target.appName, {
    createIfMissing: true,
  });
  input.onLog?.(`Pulling ${input.reference} into Modal`);
  const image = await client.images
    .fromRegistry(input.reference, secret)
    .build(app);
  await image.publish(input.name);
  return input.name;
}

export async function registerE2bTemplate(input: {
  apiKey: string;
  name: string;
  reference: string;
  registry: SandboxImageRegistryConfig;
  scriptPath: string;
  onLog?: (message: string) => void;
}): Promise<string> {
  const registry = credentials(input.registry);
  const child = spawn(
    process.execPath,
    [input.scriptPath, input.name, input.reference],
    {
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        E2B_API_KEY: input.apiKey,
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        ...(registry === null
          ? {}
          : {
              BB_SANDBOX_IMAGE_REGISTRY_USERNAME: registry.username,
              BB_SANDBOX_IMAGE_REGISTRY_TOKEN: registry.password,
            }),
        ...(process.env.HTTPS_PROXY
          ? { HTTPS_PROXY: process.env.HTTPS_PROXY }
          : {}),
        ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
        ...(process.env.NODE_EXTRA_CA_CERTS
          ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
    input.onLog?.(chunk.trimEnd());
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(
      `E2B template registration exited ${exitCode}${detail ? `: ${detail}` : ""}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("E2B template registration returned invalid JSON");
  }
  return e2bBuildSchema.parse(parsed).name;
}

export interface SandboxImageRegistrationRequest {
  provider: SandboxImageProvider;
  name: string;
  /** Immutable `repository@sha256:…` form. */
  pinnedReference: string;
  /** Mutable `repository:version` form, for providers that reject a digest. */
  reference: string;
  settings: SandboxSettings;
  registry: SandboxImageRegistryConfig;
  /** For providers sized by their image: the tier this registration serves. */
  sizeTier?: SandboxSizeTier;
  /** For providers with regions: where to register, else the configured default. */
  regionId?: string;
  onLog?: (message: string) => void;
}

export interface SandboxImageRegistrationInput
  extends SandboxImageRegistrationRequest {
  e2bScriptPath: string;
  env?: NodeJS.ProcessEnv;
}

export async function registerSandboxImage(
  input: SandboxImageRegistrationInput,
): Promise<SandboxImageRegistrationResult> {
  const env = input.env ?? process.env;
  const configured = (...values: Array<string | undefined>): string | null =>
    values.map((value) => value?.trim()).find(Boolean) ?? null;
  const privateRegistry = credentials(input.registry) !== null;
  if (input.provider === "daytona") {
    const apiKey = configured(
      input.settings.daytonaApiKey,
      env.DAYTONA_API_KEY,
    );
    if (apiKey === null) throw new Error("Configure the Daytona API key first");
    const apiUrl = configured(
      input.settings.daytonaApiUrl,
      env.DAYTONA_API_URL,
    );
    const target = configured(input.settings.daytonaTarget, env.DAYTONA_TARGET);
    return registerDaytonaSnapshot({
      target: {
        apiKey,
        ...(apiUrl === null ? {} : { apiUrl }),
        ...(target === null ? {} : { target }),
        sandboxClass:
          configured(
            input.settings.daytonaSandboxClass,
            env.BB_SANDBOX_DAYTONA_CLASS,
          ) === "linux-vm"
            ? "linux-vm"
            : configured(
                  input.settings.daytonaSandboxClass,
                  env.BB_SANDBOX_DAYTONA_CLASS,
                ) === "windows"
              ? "windows"
              : "container",
      },
      name: input.name,
      // Daytona's snapshot API rejects a digest reference: it re-serializes
      // `repo@sha256:…` as `repo:sha256:…` and then fails to pull. The build's
      // version tag is written once and never moved, so it pins in practice.
      reference: input.reference,
      registry: input.registry,
      ...(input.sizeTier === undefined ? {} : { sizeTier: input.sizeTier }),
      ...(input.regionId === undefined ? {} : { regionId: input.regionId }),
      ...(input.onLog === undefined ? {} : { onLog: input.onLog }),
    });
  }
  if (input.provider === "modal") {
    const tokenId = configured(input.settings.modalTokenId, env.MODAL_TOKEN_ID);
    const tokenSecret = configured(
      input.settings.modalTokenSecret,
      env.MODAL_TOKEN_SECRET,
    );
    if (tokenId === null || tokenSecret === null) {
      throw new Error("Configure the Modal token ID and secret first");
    }
    const name = await registerModalImage({
      target: {
        tokenId,
        tokenSecret,
        appName: configured(input.settings.modalApp) ?? "bb-sandboxes",
      },
      name: input.name,
      reference: input.pinnedReference,
      registry: input.registry,
      ...(input.onLog === undefined ? {} : { onLog: input.onLog }),
    });
    return { name, placement: null };
  }
  if (input.provider === "e2b") {
    const apiKey = configured(input.settings.e2bApiKey, env.E2B_API_KEY);
    if (apiKey === null) throw new Error("Configure the E2B API key first");
    const name = await registerE2bTemplate({
      apiKey,
      name: input.name,
      reference: input.pinnedReference,
      registry: input.registry,
      scriptPath: input.e2bScriptPath,
      ...(input.onLog === undefined ? {} : { onLog: input.onLog }),
    });
    return { name, placement: null };
  }
  // Nirvana pulls the reference straight from its sandbox spec, so the pinned
  // reference is the registration. Like Daytona it has no per-request auth.
  if (privateRegistry) {
    input.onLog?.(
      "Nirvana pulls images with cluster credentials; a private repository must be configured on the Nirvana side",
    );
  }
  return { name: input.pinnedReference, placement: null };
}

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
/** The shape `SandboxImageManager` generates: a zero-padded UTC timestamp. */
const versionTagPattern = /^\d{8}t\d{6}z$/u;
const manifestAcceptTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Registries that hold no tags answer with `"tags": null` rather than `[]`. */
const tagListSchema = z.object({
  tags: z.array(z.string()).nullable().optional(),
});

const registryTokenSchema = z.object({
  token: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
});

export interface RegistryImageReference {
  repository: string;
  tag: string;
  digest: string;
  /** Mutable `repository:tag`, for providers that reject a digest. */
  reference: string;
  /** Immutable `repository@sha256:…`. */
  pinnedReference: string;
}

/**
 * Generated versions are zero-padded UTC timestamps, so lexicographic order is
 * chronological order. Every other tag is ignored on purpose: `latest` and
 * hand-written names move, and Daytona pins its snapshot by tag rather than by
 * digest, so a moving tag would silently change what a snapshot pulls.
 */
export function newestImageVersionTag(tags: readonly string[]): string | null {
  const versions = tags.filter((tag) => versionTagPattern.test(tag)).sort();
  return versions.at(-1) ?? null;
}

interface RegistryEndpoint {
  /** Host as it appears in the reference. */
  host: string;
  /** Host that serves the `/v2` API, which differs on Docker Hub. */
  apiHost: string;
  path: string;
}

/**
 * OCI reference rules: the first path segment is a registry host only when it
 * looks like one. Anything else is a Docker Hub repository, and a
 * single-segment Docker Hub repository lives under `library/`.
 */
function registryEndpoint(repository: string): RegistryEndpoint {
  const segments = repository.split("/");
  const candidate = segments.length > 1 ? (segments[0] ?? "") : "";
  const named =
    candidate.includes(".") ||
    candidate.includes(":") ||
    candidate === "localhost";
  const host = named ? candidate : "docker.io";
  const rest = named ? segments.slice(1) : segments;
  return {
    host,
    apiHost: host === "docker.io" ? "registry-1.docker.io" : host,
    path:
      host === "docker.io" && rest.length === 1
        ? `library/${rest[0] ?? ""}`
        : rest.join("/"),
  };
}

function parseChallenge(
  header: string,
): { realm: string; params: URLSearchParams } | null {
  if (!/^bearer /iu.test(header)) return null;
  const params = new URLSearchParams();
  let realm: string | null = null;
  for (const match of header.slice("bearer ".length).matchAll(
    /([a-z_]+)="([^"]*)"/giu,
  )) {
    const key = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? "";
    if (key === "realm") realm = value;
    else params.set(key, value);
  }
  return realm === null ? null : { realm, params };
}

/**
 * One registry API call, following the standard bearer challenge. GHCR always
 * challenges, even for a public repository, and exchanges the stored token for
 * a scoped one over basic auth.
 */
async function registryRequest(input: {
  endpoint: RegistryEndpoint;
  path: string;
  accept: string | null;
  registry: SandboxImageRegistryConfig;
}): Promise<Response> {
  const url = `https://${input.endpoint.apiHost}/v2/${input.endpoint.path}${input.path}`;
  const headers: Record<string, string> =
    input.accept === null ? {} : { Accept: input.accept };
  const direct = await fetch(url, { headers });
  if (direct.status !== 401) return direct;
  const challenge = parseChallenge(
    direct.headers.get("www-authenticate") ?? "",
  );
  if (challenge === null) return direct;
  const registryCredentials = credentials(input.registry);
  const tokenUrl = new URL(challenge.realm);
  for (const [key, value] of challenge.params) {
    tokenUrl.searchParams.set(key, value);
  }
  const issued = await fetch(tokenUrl.toString(), {
    headers:
      registryCredentials === null
        ? {}
        : {
            Authorization: `Basic ${Buffer.from(
              `${registryCredentials.username}:${registryCredentials.password}`,
            ).toString("base64")}`,
          },
  });
  if (!issued.ok) {
    throw new Error(
      `Could not authenticate with ${input.endpoint.host} (HTTP ${issued.status}); check the image registry username and token`,
    );
  }
  const parsed = registryTokenSchema.parse(await issued.json());
  const bearer = parsed.token ?? parsed.access_token;
  if (bearer === undefined) {
    throw new Error(`${input.endpoint.host} issued no registry token`);
  }
  return fetch(url, { headers: { ...headers, Authorization: `Bearer ${bearer}` } });
}

export async function listRegistryTags(
  registry: SandboxImageRegistryConfig,
): Promise<string[]> {
  const response = await registryRequest({
    endpoint: registryEndpoint(registry.repository),
    path: "/tags/list?n=1000",
    accept: null,
    registry,
  });
  if (!response.ok) {
    throw new Error(
      `Could not list tags for ${registry.repository} (HTTP ${response.status}); the registry token needs pull access`,
    );
  }
  return tagListSchema.parse(await response.json()).tags ?? [];
}

export async function resolveRegistryDigest(
  registry: SandboxImageRegistryConfig,
  tag: string,
): Promise<string> {
  const response = await registryRequest({
    endpoint: registryEndpoint(registry.repository),
    path: `/manifests/${encodeURIComponent(tag)}`,
    accept: manifestAcceptTypes,
    registry,
  });
  if (!response.ok) {
    throw new Error(
      `${registry.repository}:${tag} is not in the registry (HTTP ${response.status})`,
    );
  }
  const advertised = response.headers.get("docker-content-digest")?.trim() ?? "";
  if (digestPattern.test(advertised)) return advertised;
  // A registry may omit the header. The digest is the sha256 of the manifest
  // bytes exactly as served, so hashing the body yields the same value.
  const body = Buffer.from(await response.arrayBuffer());
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

const manifestListMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

const manifestDocumentSchema = z.object({
  mediaType: z.string().optional(),
  config: z.object({ digest: z.string() }).optional(),
  manifests: z
    .array(
      z.object({
        digest: z.string(),
        mediaType: z.string().optional(),
        platform: z
          .object({ os: z.string().optional(), architecture: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
});

const imageConfigSchema = z.object({
  config: z
    .object({ Labels: z.record(z.string(), z.string()).nullable().optional() })
    .optional(),
});

/**
 * Read one OCI label from an image the registry already holds, without
 * pulling it. CI builds the Dockerfile verbatim, which stamps
 * `bb.app.version`, so a registered image can report the bb-app it carries.
 * Any registry that cannot answer yields null rather than failing
 * registration: the label is bookkeeping, not a prerequisite.
 */
export async function readRegistryImageLabel(input: {
  registry: SandboxImageRegistryConfig;
  reference: string;
  label: string;
  platform?: string;
}): Promise<string | null> {
  const repository = input.registry.repository.trim();
  const registry = { ...input.registry, repository };
  const endpoint = registryEndpoint(repository);
  const manifest = async (reference: string) => {
    const response = await registryRequest({
      endpoint,
      path: `/manifests/${encodeURIComponent(reference)}`,
      accept: manifestAcceptTypes,
      registry,
    });
    if (!response.ok) return null;
    return manifestDocumentSchema.parse(await response.json());
  };
  try {
    let document = await manifest(input.reference);
    if (document === null) return null;
    if (
      document.manifests !== undefined &&
      (document.config === undefined ||
        (document.mediaType !== undefined &&
          manifestListMediaTypes.has(document.mediaType)))
    ) {
      const [wantOs, wantArch] = (input.platform ?? "linux/amd64").split("/");
      const candidate =
        document.manifests.find(
          (entry) =>
            entry.platform?.os === wantOs &&
            entry.platform.architecture === wantArch,
        ) ??
        document.manifests.find(
          (entry) => entry.platform?.os !== "unknown",
        ) ??
        document.manifests[0];
      if (candidate === undefined) return null;
      document = await manifest(candidate.digest);
      if (document === null) return null;
    }
    if (document.config === undefined) return null;
    const blob = await registryRequest({
      endpoint,
      path: `/blobs/${encodeURIComponent(document.config.digest)}`,
      accept: null,
      registry,
    });
    if (!blob.ok) return null;
    const config = imageConfigSchema.parse(await blob.json());
    const value = config.config?.Labels?.[input.label]?.trim() ?? "";
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

/**
 * Turn what an operator has — nothing, a tag, or a full `repository:tag` — into
 * both reference forms the providers need. CI pushes the image, so the plugin
 * only ever reads the registry here.
 */
export async function resolveRegistryImage(input: {
  registry: SandboxImageRegistryConfig;
  reference: string | null;
  onLog?: (message: string) => void;
}): Promise<RegistryImageReference> {
  const repository = input.registry.repository.trim();
  if (repository.length === 0) {
    throw new Error(
      "Set the sandbox image repository (for example ghcr.io/acme/bb-sandbox) before registering an image",
    );
  }
  const requested = input.reference?.trim() ?? "";
  let tag: string;
  if (requested.length === 0) {
    const tags = await listRegistryTags({ ...input.registry, repository });
    const newest = newestImageVersionTag(tags);
    if (newest === null) {
      throw new Error(
        `${repository} holds no timestamped sandbox image tag; run the sandbox-image workflow or pass --reference <tag>`,
      );
    }
    tag = newest;
    input.onLog?.(`Newest tag in ${repository} is ${tag}`);
  } else if (requested.includes("@")) {
    throw new Error(
      "Pass the image tag rather than a digest: Daytona pins its snapshot by tag, and the plugin resolves the digest itself",
    );
  } else {
    const separator = requested.lastIndexOf(":");
    const named =
      separator > requested.lastIndexOf("/") ? requested.slice(0, separator) : "";
    if (named.length > 0 && named !== repository) {
      throw new Error(
        `${requested} is not in the configured repository ${repository}`,
      );
    }
    tag = named.length > 0 ? requested.slice(separator + 1) : requested;
  }
  const digest = await resolveRegistryDigest({ ...input.registry, repository }, tag);
  input.onLog?.(`Resolved ${repository}:${tag} to ${digest}`);
  return {
    repository,
    tag,
    digest,
    reference: `${repository}:${tag}`,
    pinnedReference: `${repository}@${digest}`,
  };
}
