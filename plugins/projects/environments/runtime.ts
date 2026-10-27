import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { capabilityById } from "./capabilities.js";
import { hostClient, MAX_HOST_CALL_MS, runCommand } from "./host-contract.js";
import type { Preparation, Profile } from "./store.js";
import type { PreparationObservation } from "./preparation-outcome.js";

interface OnePasswordMetadata {
  account: string;
  environmentId: string;
  serviceAccountName: string;
}

const OP_VERSION = "2.33.0-beta.02";

export const credentialCheckerSource = `const requirements=JSON.parse(process.argv[1]);for(const requirement of requirements){const ready=requirement.anyOf.some(group=>group.every(name=>typeof process.env[name]==="string"&&process.env[name].length>0));process.stdout.write("credential:"+requirement.id+"\\t"+(ready?"ready":"missing")+"\\n");}`;

const helperSource = `#!/usr/bin/env node
const { chmodSync, readFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const OP_VERSION = ${JSON.stringify(OP_VERSION)};

function fail(message) { process.stderr.write(message + "\\n"); process.exit(1); }
if (process.argv.length < 3) fail("Usage: bb-project-env-run <command> [args...]");
const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
if (git.status !== 0) fail("Run this command inside a configured Git checkout");
const metadataPath = resolve(git.stdout.trim(), "bb-project-environment.json");
let metadata;
try { metadata = JSON.parse(readFileSync(metadataPath, "utf8")); }
catch { fail("This checkout has not been prepared. Run: bb project-env prepare"); }
const mise = process.env.HOME + "/.local/bin/mise";
const miseCommand = require("node:fs").existsSync(mise) ? mise : "mise";
const childPath = [process.env.HOME + "/.local/bin", process.env.HOME + "/.local/share/mise/shims", process.env.PATH].filter(Boolean).join(":");
const help = spawnSync(miseCommand, ["x", "1password-cli@" + OP_VERSION, "--", "op", "run", "--help"], { encoding: "utf8" });
if (help.status !== 0 || !String(help.stdout).includes("--environment")) {
  fail("This project needs mise and 1password-cli@" + OP_VERSION + ". Run: mise install 1password-cli@" + OP_VERSION);
}
let token;
try { token = readFileSync(metadata.tokenFile, "utf8").trim(); }
catch { fail("The scoped 1Password service-account token is missing on this machine"); }
if (!token) fail("The scoped 1Password service-account token is empty");
try {
  chmodSync(dirname(dirname(metadata.tokenFile)), 0o700);
  chmodSync(dirname(metadata.tokenFile), 0o700);
  chmodSync(metadata.tokenFile, 0o600);
} catch { fail("Could not secure the scoped 1Password credential directory"); }
const args = ["x", "1password-cli@" + OP_VERSION, "--", "op"];
if (metadata.account) args.push("--account", metadata.account);
const requested = process.argv.slice(2);
const checkMode = requested.length === 1 && requested[0] === "--check";
const checker = ${JSON.stringify(credentialCheckerSource)};
const command = checkMode
  ? [process.execPath, "-e", checker, JSON.stringify(metadata.credentialRequirements || [])]
  : requested;
args.push("run", "--environment", metadata.environmentId, "--", "env", "-u", "OP_SERVICE_ACCOUNT_TOKEN", "PATH=" + childPath, ...command);
const child = spawnSync(miseCommand, args, { stdio: checkMode ? ["ignore", "pipe", "inherit"] : "inherit", encoding: checkMode ? "utf8" : undefined, env: { ...process.env, MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS: "node", OP_SERVICE_ACCOUNT_TOKEN: token } });
if (checkMode && child.stdout) process.stdout.write(child.stdout);
process.exit(child.status ?? 1);
`;

function credentialDetail(alternatives: readonly (readonly string[])[]): string {
  return alternatives.every((group) => group.length === 0)
    ? "no 1Password variables; this capability uses separate OAuth"
    : alternatives.map((group) => group.join(" + ")).join(" or ");
}

function firstAssignment(content: string): string {
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator >= 0 && line.slice(separator + 1).trim()) return line.slice(separator + 1).trim();
  }
  return "";
}

async function optionalWorkspaceFile(bb: BbPluginApi, hostId: string, workspacePath: string, relativePath: string): Promise<string> {
  try {
    const result = await bb.sdk.files.read({ hostId, rootPath: workspacePath, path: `${workspacePath}/${relativePath}` });
    return result.contentEncoding === "base64" ? Buffer.from(result.content, "base64").toString("utf8") : result.content;
  } catch {
    return "";
  }
}

async function resolveOnePasswordMetadata(bb: BbPluginApi, hostId: string, workspacePath: string, profile: Profile): Promise<OnePasswordMetadata> {
  const [accounts, environments, serviceAccounts] = await Promise.all([
    optionalWorkspaceFile(bb, hostId, workspacePath, ".1password/accounts"),
    optionalWorkspaceFile(bb, hostId, workspacePath, ".1password/environments"),
    optionalWorkspaceFile(bb, hostId, workspacePath, ".1password/service-accounts"),
  ]);
  return {
    account: firstAssignment(accounts) || profile.account,
    environmentId: firstAssignment(environments) || profile.environmentId,
    serviceAccountName: firstAssignment(serviceAccounts) || profile.serviceAccountName,
  };
}

export class ServiceAccountTokenStore {
  private readonly root: string;

  constructor(databasePath: string) {
    this.root = join(dirname(databasePath), "secrets", "onepassword");
  }

  private path(profileId: string): string {
    return join(this.root, profileId);
  }

  async configured(profileId: string): Promise<boolean> {
    try {
      return (await readFile(this.path(profileId), "utf8")).trim().length > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async read(profileId: string): Promise<string> {
    try {
      return (await readFile(this.path(profileId), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async write(profileId: string, token: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(profileId);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, token.trim(), { mode: 0o600 });
    await rename(temporary, target);
  }

  async remove(profileId: string): Promise<void> {
    await rm(this.path(profileId), { force: true });
  }
}

export async function cleanupWorkspace(args: {
  bb: BbPluginApi;
  hostId: string;
  workspacePath: string;
  profileId: string;
  preserveSharedToken?: boolean;
  observation?: PreparationObservation;
}): Promise<void> {
  await hostClient(args.bb, args.observation).call("cleanup", {
    cwd: args.workspacePath,
    profileId: args.profileId,
    preserveSharedToken: args.preserveSharedToken ?? false,
  }, { hostId: args.hostId });
}

export async function prepareWorkspace(args: {
  bb: BbPluginApi;
  projectId: string;
  hostId: string;
  workspacePath: string;
  profile: Profile | null;
  skipWorkspaceSetup?: boolean;
  toolIds?: import("./contract.js").CapabilityId[];
  tokenStore: ServiceAccountTokenStore;
  workspaceSetupScript?: string;
  materializeCatalog?: (input: { homePath: string }) => Promise<{ ready: boolean; skillCount: number; detail: string }>;
  observation?: PreparationObservation;
}): Promise<Preparation> {
  const { bb, projectId, hostId, workspacePath, tokenStore } = args;
  const profile = args.profile && args.toolIds !== undefined ? { ...args.profile, capabilities: args.toolIds } : args.profile;
  const checks: Preparation["checks"] = [];
  const preparedAt = new Date().toISOString();
  if (!profile) {
    return {
      projectId, profileId: null, hostId, workspacePath, ready: false, preparedAt,
      checks: [{ id: "binding", label: "Credential assignment", status: "missing", detail: "Choose a credential set for this project." }],
    };
  }

  checks.push({ id: "binding", label: "Project binding", status: "ready", detail: profile.name });
  const metadata = await resolveOnePasswordMetadata(bb, hostId, workspacePath, profile);
  const token = await tokenStore.read(profile.id);
  const configurationReady = Boolean(metadata.environmentId && metadata.serviceAccountName);
  checks.push({
    id: "onepassword-metadata",
    label: "1Password Environment",
    status: configurationReady ? "ready" : "missing",
    detail: configurationReady ? `${profile.environmentName || profile.name} · scoped service account` : "Add an Environment ID and service-account name, or commit .1password metadata.",
  });
  checks.push({
    id: "onepassword-token",
    label: "Scoped credential",
    status: token ? "ready" : "missing",
    detail: token ? "Available to stage on this machine." : "Add the Environment's read-only service-account token.",
  });

  const host = hostClient(bb, args.observation);
  const { home, miseInstalled, opEnvironmentSupported: environmentSupported } = await host.call("bootstrap", { opVersion: OP_VERSION }, { hostId, timeoutMs: 10 * 60_000 });
  checks.push({ id: "mise", label: "mise", status: miseInstalled ? "ready" : "missing", detail: miseInstalled ? "Installed." : "Could not install mise on this machine." });
  checks.push({
    id: "op-environment",
    label: "1Password CLI beta",
    status: environmentSupported ? "ready" : "missing",
    detail: environmentSupported ? `mise-managed 1password-cli@${OP_VERSION} supports Environments.` : `Run: mise install 1password-cli@${OP_VERSION}`,
  });

  if (home && args.materializeCatalog) {
    let catalog: Awaited<ReturnType<NonNullable<typeof args.materializeCatalog>>> | null = null;
    let catalogError: unknown;
    for (let attempt = 0; attempt < 2 && catalog === null; attempt += 1) {
      try {
        catalog = await args.materializeCatalog({ homePath: home });
      } catch (error) {
        catalogError = error;
      }
    }
    if (catalog !== null) {
      checks.push({
        id: "catalog",
        label: "Catalog skills",
        status: catalog.ready ? "ready" : "missing",
        detail: catalog.detail,
      });
    } else {
      checks.push({
        id: "catalog",
        label: "Catalog skills",
        status: "missing",
        detail: `Could not materialize assigned skills after retry: ${catalogError instanceof Error ? catalogError.message : String(catalogError)}`,
      });
    }
  }

  // Skip the (often slow) install script when every declared capability's
  // command is already on PATH — e.g. pre-baked into the sandbox image. This is
  // what keeps preparation fast: without it, a profile whose tools ship in the
  // image (e.g. hubspot in /usr/local/bin) would still re-download and
  // re-install them every prep, which is what pushed the step past its timeout.
  const commands = profile.capabilities.map((id) => capabilityById.get(id)?.command ?? id);
  let toolsAlreadyPresent = false;
  if (profile.setupScript.trim() && profile.capabilities.length > 0) {
    const installProbe = await host.call("probe", { cwd: workspacePath, commands }, { hostId });
    toolsAlreadyPresent = installProbe.missing.length === 0;
  }

  if (profile.setupScript.trim() && toolsAlreadyPresent) {
    checks.push({
      id: "setup",
      label: "Machine setup",
      status: "ready",
      detail: "Required tools are already installed on this machine; skipped the setup script.",
    });
  } else if (profile.setupScript.trim()) {
    // The tool-install step must never block staging the credential launcher
    // below: bb-project-env-run and the scoped 1Password token do not depend on
    // these capability CLIs (op and mise are installed in earlier steps). A
    // slow install that exceeds the timeout used to THROW here, aborting the
    // whole preparation before the launcher was written — so a profile with
    // several tools that are NOT baked into the image could leave the host with
    // no bb-project-env-run at all. Treat a timeout or crash as a degraded
    // "setup" check and press on so credentials still work.
    try {
      const setup = await runCommand(host, hostId, { cwd: workspacePath, command: "bash", args: ["-eu", "-c", profile.setupScript], timeoutMs: 20 * 60_000 });
      checks.push({
        id: "setup",
        label: "Machine setup",
        status: setup.exitCode === 0 ? "ready" : "missing",
        detail: setup.timedOut
          ? "Tool install did not finish in time; some tools may be missing. Credentials were still staged — rerun preparation to finish installing tools."
          : setup.exitCode === 0 ? "The idempotent setup script completed." : `The setup script exited with code ${setup.exitCode}.`,
      });
    } catch (error) {
      checks.push({
        id: "setup",
        label: "Machine setup",
        status: "missing",
        detail: `The setup script failed: ${error instanceof Error ? error.message : String(error)}. Credentials were still staged.`,
      });
    }
  } else {
    checks.push({ id: "setup", label: "Machine setup", status: "skipped", detail: "No setup script configured." });
  }

  const probe = await host.call("probe", { cwd: workspacePath, commands }, { hostId });
  const gitCommon = probe.gitCommonDir ?? "";

  for (const id of profile.capabilities) {
    const capability = capabilityById.get(id)!;
    const installed = !probe.missing.includes(capability.command);
    checks.push({ id: `capability:${id}`, label: capability.name, status: installed ? "ready" : "missing", detail: installed ? `${capability.command} is installed.` : capability.installHint });
  }

  if (!home || !gitCommon) {
    checks.push({ id: "workspace", label: "Git workspace", status: "missing", detail: "Could not resolve the host home or Git common directory." });
  } else if (configurationReady && token) {
    const tokenDirectory = `${home}/.config/op/service-accounts`;
    const tokenPath = `${tokenDirectory}/${metadata.serviceAccountName}-${createHash("sha256").update(gitCommon).digest("hex").slice(0, 16)}`;
    const helperPath = `${home}/.local/bin/bb-project-env-run`;
    const credentialRequirements = profile.capabilities.map((id) => {
      const capability = capabilityById.get(id)!;
      return { id, anyOf: capability.credentialAlternatives };
    });
    await host.call("stage", {
      tokenPath,
      token,
      helperPath,
      helperSource,
      metadataPath: `${gitCommon}/bb-project-environment.json`,
      metadata: `${JSON.stringify({ schemaVersion: 2, profileId: profile.id, profileName: profile.name, account: metadata.account, environmentId: metadata.environmentId, tokenFile: tokenPath, tokenScope: "workspace", legacyTokenFile: `${tokenDirectory}/${metadata.serviceAccountName}`, capabilities: profile.capabilities, credentialRequirements }, null, 2)}\n`,
    }, { hostId });
    checks.push({ id: "runtime", label: "Runtime launcher", status: "ready", detail: "Installed bb-project-env-run and staged the scoped credential." });

    const credentialProbe = await runCommand(host, hostId, { cwd: workspacePath, command: helperPath, args: ["--check"], timeoutMs: 2 * 60_000 });
    const credentialAccessReady = credentialProbe.exitCode === 0;
    checks.push({
      id: "credential-access",
      label: "Credential inspection",
      status: credentialAccessReady ? "ready" : "missing",
      detail: credentialAccessReady
        ? "Checked the declared variable names without reading their values."
        : "Could not inspect this 1Password Environment. Verify its ID and scoped service-account token.",
    });
    const credentialValues = new Map(credentialProbe.stdout.split(/\r?\n/u).map((line) => {
      const separator = line.indexOf("\t");
      return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    for (const id of profile.capabilities) {
      const capability = capabilityById.get(id)!;
      const ready = credentialAccessReady && credentialValues.get(`credential:${id}`) === "ready";
      checks.push({
        id: `credential:${id}`,
        label: `${capability.name} credential`,
        status: ready ? "ready" : credentialAccessReady ? "missing" : "skipped",
        detail: ready
          ? capability.credentialAlternatives.every((group) => group.length === 0)
            ? "No 1Password variables are required; OAuth is checked separately."
            : "Required variables are present in the scoped 1Password Environment."
          : credentialAccessReady
            ? `Add ${credentialDetail(capability.credentialAlternatives)} to the scoped 1Password Environment.`
            : "Credential names were not checked because 1Password Environment access failed.",
      });
    }
    if (!args.skipWorkspaceSetup && args.workspaceSetupScript?.trim()) {
      if (!credentialAccessReady) {
        checks.push({
          id: "workspace-setup",
          label: "Workspace setup",
          status: "missing",
          detail: "Credentialed workspace setup was skipped because scoped credential access failed.",
        });
      } else {
        const workspaceSetup = await runCommand(host, hostId, { cwd: workspacePath, command: helperPath, args: ["sh", "-eu", "-c", args.workspaceSetupScript], timeoutMs: MAX_HOST_CALL_MS - 60_000 });
        checks.push({
          id: "workspace-setup",
          label: "Workspace setup",
          status: workspaceSetup.exitCode === 0 ? "ready" : "missing",
          detail: workspaceSetup.exitCode === 0
            ? "The credentialed workspace recipe completed."
            : workspaceSetup.timedOut
              ? "The credentialed workspace recipe did not finish in time."
              : `The credentialed workspace recipe exited with code ${workspaceSetup.exitCode}.`,
        });
      }
    }
  } else {
    checks.push({ id: "runtime", label: "Runtime launcher", status: "skipped", detail: "Complete the 1Password configuration before staging this machine." });
  }

  return { projectId, profileId: profile.id, hostId, workspacePath, ready: checks.every((check) => check.status !== "missing"), preparedAt, checks };
}
