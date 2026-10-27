import type { SandboxProvider } from "./backend.js";
import { formatSizeTier, type SandboxSizeTier } from "./size-tiers.js";
import type {
  SandboxImageRecord,
  SandboxProjectImageRecord,
  SandboxRecord,
} from "./store.js";

/**
 * How a recorded bb-app compares with the bb server the plugin runs under.
 * `unknown` means nothing recorded a version yet: an image registered before
 * labels existed, or a sandbox created before versions were tracked.
 */
export type SandboxVersionState = "current" | "behind" | "unknown";

export interface VersionAuditImage {
  provider: SandboxProvider;
  imageId: string;
  name: string;
  bbAppVersion: string | null;
  state: SandboxVersionState;
  /** The size this image serves, for providers sized by their image. */
  sizeTier: SandboxSizeTier | null;
}

/** One size on a provider whose machines take their size from the image. */
export interface VersionAuditSizeTier {
  provider: SandboxProvider;
  tier: SandboxSizeTier;
  /** The plugin default or a project's chosen size: somebody depends on it. */
  required: boolean;
  imageId: string | null;
  imageName: string | null;
  bbAppVersion: string | null;
  /** `missing` when no active image serves the size at all. */
  state: SandboxVersionState | "missing";
}

export interface VersionAuditPin {
  projectId: string;
  provider: SandboxProvider;
  imageId: string;
  imageName: string;
  bbAppVersion: string | null;
  state: SandboxVersionState;
}

export interface VersionAuditSandbox {
  id: string;
  provider: SandboxProvider;
  projectId: string;
  projectName: string;
  status: SandboxRecord["status"];
  bbAppVersion: string | null;
  state: SandboxVersionState;
  /** A thread is running on the machine, so an upgrade must wait. */
  busy: boolean;
  /** The provider can restart the machine, which `bb sandbox upgrade` needs. */
  upgradeable: boolean;
  /** An upgrade was requested and waits for the machine to go idle. */
  upgradePending: boolean;
  /** bb refused this machine's daemon; the protocol it offered. */
  rejectedProtocol: number | null;
}

export interface VersionAuditFinding {
  severity: "error" | "warning";
  code:
    | "image-behind"
    | "image-version-unknown"
    | "size-image-missing"
    | "pin-behind"
    | "pin-version-unknown"
    | "sandbox-rejected"
    | "sandbox-behind"
    | "sandbox-behind-busy"
    | "sandbox-not-upgradeable"
    | "sandbox-version-unknown";
  message: string;
  /** The one command that resolves the finding, or null when none exists. */
  fix: string | null;
  provider: SandboxProvider;
  sandboxId?: string;
  projectId?: string;
}

export interface VersionAudit {
  serverVersion: string;
  /** The bb version the plugin last ran under, when it differs. */
  previousServerVersion: string | null;
  images: VersionAuditImage[];
  pins: VersionAuditPin[];
  sandboxes: VersionAuditSandbox[];
  sizeTiers: VersionAuditSizeTier[];
  findings: VersionAuditFinding[];
  checkedAt: number;
}

export interface VersionAuditSandboxInput {
  record: SandboxRecord;
  busy: boolean;
  upgradeable: boolean;
  upgradePending: boolean;
  rejectedProtocol: number | null;
}

export function versionState(
  version: string | null,
  serverVersion: string,
): SandboxVersionState {
  if (version === null) return "unknown";
  return version === serverVersion ? "current" : "behind";
}

/**
 * Pure audit over what the store and bb already know. Probing machines for
 * their real version is the manager's job; this only compares records.
 */
export function auditVersions(input: {
  serverVersion: string;
  previousServerVersion: string | null;
  defaultImages: SandboxImageRecord[];
  pins: Array<SandboxProjectImageRecord & { bbAppVersion: string | null }>;
  sandboxes: VersionAuditSandboxInput[];
  /** Sizes of image-sized providers, with the active image for each. */
  sizeTiers?: Array<{
    provider: SandboxProvider;
    tier: SandboxSizeTier;
    required: boolean;
    image: SandboxImageRecord | null;
  }>;
  now?: number;
}): VersionAudit {
  const { serverVersion } = input;
  const findings: VersionAuditFinding[] = [];
  const images = input.defaultImages.map((image): VersionAuditImage => ({
    provider: image.provider,
    imageId: image.id,
    name: image.name,
    bbAppVersion: image.bbAppVersion,
    state: versionState(image.bbAppVersion, serverVersion),
    sizeTier: image.sizeTier,
  }));
  for (const image of images) {
    const sized = image.sizeTier === null ? "" : ` (size ${image.sizeTier})`;
    if (image.state === "behind") {
      findings.push({
        severity: "error",
        code: "image-behind",
        provider: image.provider,
        message: `The active ${image.provider} image ${image.name}${sized} carries bb-app ${image.bbAppVersion ?? "?"}, not ${serverVersion}; new sandboxes will not connect`,
        fix: `bb sandbox build-image --provider ${image.provider}`,
      });
    } else if (image.state === "unknown") {
      findings.push({
        severity: "warning",
        code: "image-version-unknown",
        provider: image.provider,
        message: `The active ${image.provider} image ${image.name} predates version tracking; its bb-app is unknown. Rebuild it, or record the version it was built with`,
        fix: `bb sandbox set-image-version ${image.imageId} <bb-app-version>`,
      });
    }
  }
  const sizeTiers = (input.sizeTiers ?? []).map((entry): VersionAuditSizeTier => ({
    provider: entry.provider,
    tier: entry.tier,
    required: entry.required,
    imageId: entry.image?.id ?? null,
    imageName: entry.image?.name ?? null,
    bbAppVersion: entry.image?.bbAppVersion ?? null,
    state:
      entry.image === null
        ? "missing"
        : versionState(entry.image.bbAppVersion, serverVersion),
  }));
  // A size with no image at all is invisible to the image checks above, yet a
  // project that chose it cannot launch. Behind or unknown images are already
  // reported per image, so only absence is new here. An optional size that
  // nobody registered is not a problem worth a line.
  for (const entry of sizeTiers) {
    if (entry.state !== "missing" || !entry.required) continue;
    findings.push({
      severity: "error",
      code: "size-image-missing",
      provider: entry.provider,
      message: `No active ${entry.provider} image serves size ${entry.tier} (${formatSizeTier(entry.tier)}), which the plugin default or a project profile depends on; those sandboxes cannot launch`,
      fix: `bb sandbox register-image --provider ${entry.provider} --tier ${entry.tier}`,
    });
  }
  const pins = input.pins.map((pin): VersionAuditPin => ({
    projectId: pin.projectId,
    provider: pin.provider,
    imageId: pin.imageId,
    imageName: pin.imageName,
    bbAppVersion: pin.bbAppVersion,
    state: versionState(pin.bbAppVersion, serverVersion),
  }));
  for (const pin of pins) {
    const clear = `bb sandbox clear-project-image --provider ${pin.provider} --project ${pin.projectId}`;
    if (pin.state === "behind") {
      findings.push({
        severity: "error",
        code: "pin-behind",
        provider: pin.provider,
        projectId: pin.projectId,
        message: `Project ${pin.projectId} is pinned to ${pin.imageName} (bb-app ${pin.bbAppVersion ?? "?"}); its new ${pin.provider} sandboxes will not connect to bb ${serverVersion}`,
        fix: clear,
      });
    } else if (pin.state === "unknown") {
      findings.push({
        severity: "warning",
        code: "pin-version-unknown",
        provider: pin.provider,
        projectId: pin.projectId,
        message: `Project ${pin.projectId} is pinned to ${pin.imageName}, whose bb-app is unknown. Record it, or clear the pin`,
        fix: `bb sandbox set-image-version ${pin.imageId} <bb-app-version>`,
      });
    }
  }
  const sandboxes = input.sandboxes.map((entry): VersionAuditSandbox => ({
    id: entry.record.id,
    provider: entry.record.provider,
    projectId: entry.record.projectId,
    projectName: entry.record.projectName,
    status: entry.record.status,
    bbAppVersion: entry.record.bbAppVersion,
    state: versionState(entry.record.bbAppVersion, serverVersion),
    busy: entry.busy,
    upgradeable: entry.upgradeable,
    upgradePending: entry.upgradePending,
    rejectedProtocol: entry.rejectedProtocol,
  }));
  for (const sandbox of sandboxes) {
    const label = `${sandbox.projectName} sandbox ${sandbox.id} [${sandbox.provider}]`;
    const upgrade = `bb sandbox upgrade ${sandbox.id}`;
    if (sandbox.rejectedProtocol !== null) {
      findings.push({
        severity: "error",
        code: "sandbox-rejected",
        provider: sandbox.provider,
        sandboxId: sandbox.id,
        message: `bb rejected the daemon on ${label} (protocol ${sandbox.rejectedProtocol}); it cannot connect until upgraded`,
        fix: sandbox.upgradeable ? upgrade : `bb sandbox delete ${sandbox.id} --yes`,
      });
      continue;
    }
    if (sandbox.state === "current") continue;
    if (sandbox.state === "unknown") {
      findings.push({
        severity: "warning",
        code: "sandbox-version-unknown",
        provider: sandbox.provider,
        sandboxId: sandbox.id,
        message: `${label} has no recorded bb-app; it is recorded the next time the machine connects, or upgrade it now`,
        fix: sandbox.upgradeable ? upgrade : null,
      });
      continue;
    }
    if (!sandbox.upgradeable) {
      findings.push({
        severity: "error",
        code: "sandbox-not-upgradeable",
        provider: sandbox.provider,
        sandboxId: sandbox.id,
        message: `${label} runs bb-app ${sandbox.bbAppVersion ?? "?"} and ${sandbox.provider} cannot restart it in place; recreate it on the current image`,
        fix: `bb sandbox delete ${sandbox.id} --yes`,
      });
    } else if (sandbox.busy) {
      findings.push({
        severity: "warning",
        code: "sandbox-behind-busy",
        provider: sandbox.provider,
        sandboxId: sandbox.id,
        message: `${label} runs bb-app ${sandbox.bbAppVersion ?? "?"} and has an active thread; ${sandbox.upgradePending ? "its upgrade is queued for when the thread goes idle" : "queue an upgrade for when it goes idle"}`,
        fix: sandbox.upgradePending ? null : "bb sandbox upgrade --all",
      });
    } else {
      findings.push({
        severity: "error",
        code: "sandbox-behind",
        provider: sandbox.provider,
        sandboxId: sandbox.id,
        message: `${label} runs bb-app ${sandbox.bbAppVersion ?? "?"}, not ${serverVersion}; it will be refused the next time its daemon reconnects`,
        fix: upgrade,
      });
    }
  }
  return {
    serverVersion,
    previousServerVersion: input.previousServerVersion,
    images,
    pins,
    sandboxes,
    sizeTiers,
    findings,
    checkedAt: input.now ?? Date.now(),
  };
}
