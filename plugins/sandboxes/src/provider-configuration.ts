import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SandboxProvider } from "./backend.js";

/**
 * Everything the plugin's own settings surface can write. The shared `image`
 * section is not provider-scoped: one image is built and pushed here, then
 * every provider is pointed at it.
 */
export interface SandboxProviderConfiguration {
  daytona: { apiUrl: string; target: string; sandboxClass: string };
  modal: { appName: string; vmRuntime: boolean };
  e2b: Record<string, never>;
  box: { machineClass: string; environment: string };
  freestyle: {
    cpu: string;
    memory: string;
    storage: string;
    persistence: "sticky" | "persistent";
    snapshotId: string;
  };
  nirvana: {
    apiEndpoint: string;
    gatewayEndpoint: string;
    imageUri: string;
    cpu: string;
    memory: string;
    storage: string;
  };
  image: { repository: string; platform: string };
}

const defaults: SandboxProviderConfiguration = {
  daytona: { apiUrl: "", target: "", sandboxClass: "container" },
  modal: { appName: "bb-sandboxes", vmRuntime: false },
  e2b: {},
  box: { machineClass: "default", environment: "base" },
  freestyle: {
    cpu: "4",
    memory: "8",
    storage: "20",
    persistence: "sticky",
    snapshotId: "",
  },
  nirvana: {
    apiEndpoint: "",
    gatewayEndpoint: "",
    imageUri: "node:22-bookworm-slim",
    cpu: "4",
    memory: "8Gi",
    storage: "50Gi",
  },
  // An empty platform defers to BB_SANDBOX_IMAGE_PLATFORM, then linux/amd64.
  image: { repository: "", platform: "" },
};

const secretKeys = {
  daytona: ["daytonaApiKey"],
  modal: ["modalTokenId", "modalTokenSecret"],
  e2b: ["e2bApiKey"],
  box: ["boxApiKey"],
  freestyle: ["freestyleApiKey"],
  nirvana: ["nirvanaApiKey"],
} as const;

const imageSecretKeys = [
  "imageRegistryUsername",
  "imageRegistryToken",
] as const;

export type SandboxProviderSecretKey =
  | (typeof secretKeys)[SandboxProvider][number]
  | (typeof imageSecretKeys)[number];

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class SandboxProviderConfigurationStore {
  private readonly root: string;
  private readonly configPath: string;
  private readonly secretsPath: string;
  private readonly requestedSecretsPath: string;

  constructor(databasePath: string) {
    this.root = dirname(databasePath);
    this.configPath = join(this.root, "provider-configuration.json");
    this.secretsPath = join(this.root, "secrets");
    this.requestedSecretsPath = join(this.root, "provider-credentials.env");
  }

  async getConfiguration(): Promise<SandboxProviderConfiguration> {
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as {
        daytona?: { apiUrl?: unknown; target?: unknown; sandboxClass?: unknown };
        modal?: { appName?: unknown; vmRuntime?: unknown };
        box?: { machineClass?: unknown; environment?: unknown };
        freestyle?: {
          cpu?: unknown;
          memory?: unknown;
          storage?: unknown;
          persistence?: unknown;
          snapshotId?: unknown;
        };
        nirvana?: {
          apiEndpoint?: unknown; gatewayEndpoint?: unknown; imageUri?: unknown;
          cpu?: unknown; memory?: unknown; storage?: unknown;
        };
        image?: { repository?: unknown; platform?: unknown };
      };
      return {
        daytona: {
          apiUrl: clean(parsed.daytona?.apiUrl),
          target: clean(parsed.daytona?.target),
          sandboxClass:
            clean(parsed.daytona?.sandboxClass) || defaults.daytona.sandboxClass,
        },
        modal: {
          appName: clean(parsed.modal?.appName) || defaults.modal.appName,
          vmRuntime: parsed.modal?.vmRuntime === true,
        },
        e2b: {},
        box: {
          machineClass: clean(parsed.box?.machineClass) || defaults.box.machineClass,
          environment: clean(parsed.box?.environment) || defaults.box.environment,
        },
        freestyle: {
          cpu: clean(parsed.freestyle?.cpu) || defaults.freestyle.cpu,
          memory: clean(parsed.freestyle?.memory) || defaults.freestyle.memory,
          storage: clean(parsed.freestyle?.storage) || defaults.freestyle.storage,
          persistence:
            clean(parsed.freestyle?.persistence) === "persistent"
              ? "persistent"
              : "sticky",
          snapshotId: clean(parsed.freestyle?.snapshotId),
        },
        nirvana: {
          apiEndpoint: clean(parsed.nirvana?.apiEndpoint),
          gatewayEndpoint: clean(parsed.nirvana?.gatewayEndpoint),
          imageUri: clean(parsed.nirvana?.imageUri) || defaults.nirvana.imageUri,
          cpu: clean(parsed.nirvana?.cpu) || defaults.nirvana.cpu,
          memory: clean(parsed.nirvana?.memory) || defaults.nirvana.memory,
          storage: clean(parsed.nirvana?.storage) || defaults.nirvana.storage,
        },
        image: {
          repository: clean(parsed.image?.repository),
          platform: clean(parsed.image?.platform),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
      throw error;
    }
  }

  async updateConfiguration(
    provider: SandboxProvider,
    values: Record<string, string | boolean>,
  ): Promise<SandboxProviderConfiguration> {
    const next = await this.copyConfiguration();
    if (provider === "daytona") {
      next.daytona = {
        apiUrl: clean(values.apiUrl),
        target: clean(values.target),
        sandboxClass:
          clean(values.sandboxClass) || defaults.daytona.sandboxClass,
      };
    } else if (provider === "modal") {
      next.modal = {
        appName: clean(values.appName) || defaults.modal.appName,
        vmRuntime: values.vmRuntime === true,
      };
    } else if (provider === "box") {
      next.box = {
        machineClass: clean(values.machineClass) || defaults.box.machineClass,
        environment: clean(values.environment) || defaults.box.environment,
      };
    } else if (provider === "freestyle") {
      next.freestyle = {
        cpu: clean(values.cpu) || defaults.freestyle.cpu,
        memory: clean(values.memory) || defaults.freestyle.memory,
        storage: clean(values.storage) || defaults.freestyle.storage,
        persistence:
          clean(values.persistence) === "persistent" ? "persistent" : "sticky",
        snapshotId: clean(values.snapshotId),
      };
    } else if (provider === "nirvana") {
      next.nirvana = {
        apiEndpoint: clean(values.apiEndpoint),
        gatewayEndpoint: clean(values.gatewayEndpoint),
        imageUri: clean(values.imageUri) || defaults.nirvana.imageUri,
        cpu: clean(values.cpu) || defaults.nirvana.cpu,
        memory: clean(values.memory) || defaults.nirvana.memory,
        storage: clean(values.storage) || defaults.nirvana.storage,
      };
    }
    return this.write(next);
  }

  async updateImageConfiguration(values: {
    repository: string;
    platform: string;
  }): Promise<SandboxProviderConfiguration> {
    const next = await this.copyConfiguration();
    next.image = {
      // The build appends its own version tag, so drop a pasted one. A port
      // (registry:5000/repo) keeps its colon because a path follows it.
      repository: clean(values.repository).replace(/:[^/:]*$/u, ""),
      platform: clean(values.platform),
    };
    return this.write(next);
  }

  private async copyConfiguration(): Promise<SandboxProviderConfiguration> {
    const current = await this.getConfiguration();
    return {
      ...current,
      daytona: { ...current.daytona },
      modal: { ...current.modal },
      e2b: {},
      box: { ...current.box },
      freestyle: { ...current.freestyle },
      nirvana: { ...current.nirvana },
      image: { ...current.image },
    };
  }

  private async write(
    next: SandboxProviderConfiguration,
  ): Promise<SandboxProviderConfiguration> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.configPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.configPath);
    return next;
  }

  async getSecret(key: SandboxProviderSecretKey): Promise<string> {
    try {
      return (await readFile(join(this.secretsPath, key), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const environmentNames: Partial<Record<SandboxProviderSecretKey, string>> = {
          boxApiKey: "BOX_API_KEY",
          freestyleApiKey: "FREESTYLE_API_KEY",
        };
        const environmentName = environmentNames[key];
        if (environmentName === undefined) return "";
        try {
          const source = await readFile(this.requestedSecretsPath, "utf8");
          for (const line of source.split(/\r?\n/u)) {
            const separator = line.indexOf("=");
            if (separator < 1 || line.slice(0, separator).trim() !== environmentName) continue;
            const raw = line.slice(separator + 1).trim();
            if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
              return raw.slice(1, -1);
            }
            return raw;
          }
          return "";
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw fallbackError;
        }
      }
      throw error;
    }
  }

  async setSecrets(values: Partial<Record<SandboxProviderSecretKey, string>>): Promise<void> {
    await mkdir(this.secretsPath, { recursive: true, mode: 0o700 });
    await Promise.all(
      Object.entries(values).map(async ([key, value]) => {
        const cleaned = clean(value);
        if (cleaned.length === 0) return;
        await writeFile(join(this.secretsPath, key), cleaned, { mode: 0o600 });
      }),
    );
  }

  async credentialStatus(provider: SandboxProvider): Promise<boolean> {
    const values = await Promise.all(
      secretKeys[provider].map((key) => this.getSecret(key)),
    );
    return values.every((value) => value.length > 0);
  }
}
