import type { AttachmentChange, AttachmentsView } from "./src/attachment-contract.js";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  experimental_Icon as AppIcon,
  experimental_useThreadActions,
  type PluginThreadActionTarget,
  useRealtime,
  useRpc,
  type PluginThreadHeaderActionProps,
  type PluginMachineProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import "./app.css";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "./components/ui/coarse-pointer-sizing";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command";
import { Icon, type IconName } from "./components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import { sandboxProviderValues, type SandboxProvider } from "./src/backend.js";
import {
  formatSizeTier,
  sandboxSizeTierValues,
} from "./src/size-tiers.js";
import type {
  SandboxUpgradeJobView,
  VersionAuditView,
  sandboxRpcContract,
} from "./src/contract.js";
import type {
  SandboxThreadResourcesView,
} from "./src/manager.js";
import type { SandboxImageRecord } from "./src/store.js";
import type { ModelRoute } from "./src/model-route.js";

function providerLabel(provider: SandboxProvider): string {
  return ({
    daytona: "Daytona", modal: "Modal", e2b: "E2B",
    box: "Box by ASCII", freestyle: "Freestyle", nirvana: "Nirvana",
  } satisfies Record<SandboxProvider, string>)[provider];
}

// Curated "where to run" ordering: persistent/idling sandboxes are preferred; the rest
// (e.g. Modal, whose sandboxes expire after 24h and do not idle) fall under "Other".
const PREFERRED_SANDBOX_PROVIDERS = new Set<SandboxProvider>([
  "daytona",
  "e2b",
  "box",
  "freestyle",
]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SearchablePickerOption<Value extends string> {
  value: Value;
  label: string;
  icon: IconName;
  disabled?: boolean;
  detail?: string;
  /** Optional section heading; options sharing a group render under one heading. */
  group?: string;
}

// Bucket options into sections by their `group`, preserving first-seen order; when no option
// declares a group everything falls under the picker's own label (the prior behavior).
function groupOptions<Value extends string>(
  options: SearchablePickerOption<Value>[],
  fallbackHeading: string,
): { heading: string; options: SearchablePickerOption<Value>[] }[] {
  const sections: { heading: string; options: SearchablePickerOption<Value>[] }[] = [];
  for (const option of options) {
    const heading = option.group ?? fallbackHeading;
    let section = sections.find((entry) => entry.heading === heading);
    if (section === undefined) {
      section = { heading, options: [] };
      sections.push(section);
    }
    section.options.push(option);
  }
  return sections;
}

function SearchablePicker<Value extends string>({
  label,
  icon,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  options,
  value,
  onChange,
  disabled = false,
  loading = false,
}: {
  label: string;
  icon: IconName;
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  options: SearchablePickerOption<Value>[];
  value: Value | null;
  onChange: (value: Value) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value) ?? null;
  const triggerIcon = loading ? "Spinner" : (selected?.icon ?? icon);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  }, []);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={`${label}: ${selected?.label ?? placeholder}`}
          className="h-8 w-full min-w-0 max-w-full justify-start gap-2 rounded-lg px-2.5 text-sm"
        >
          <Icon
            name={triggerIcon}
            className={`size-4 shrink-0 ${loading ? "animate-spin" : ""}`}
            aria-hidden
          />
          <span className="truncate">
            {loading
              ? `Loading ${label.toLowerCase()}`
              : (selected?.label ?? placeholder)}
          </span>
          <Icon
            name="ChevronDown"
            className="ml-auto size-4 shrink-0"
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        mobileTitle={label}
        className="w-full md:w-[var(--radix-popover-trigger-width)] md:max-w-[calc(100vw-2rem)] md:p-0"
      >
        <Command>
          <CommandInput
              className="min-w-0 text-xs"
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[min(20rem,calc(var(--radix-popover-content-available-height,80vh)-2.75rem))] overscroll-contain">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {groupOptions(options, label).map((section) => (
              <CommandGroup key={section.heading} heading={section.heading}>
                {section.options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.value}`}
                    aria-label={[option.label, option.detail].filter(Boolean).join(" · ")}
                    disabled={option.disabled}
                    className="min-h-8 px-2 text-xs data-[selected=true]:bg-state-hover data-[selected=true]:text-foreground"
                    onSelect={() => {
                      onChange(option.value);
                      handleOpenChange(false);
                    }}
                  >
                    <Icon
                      name={option.icon}
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block whitespace-normal break-words">{option.label}</span>
                      {option.detail ? <span className="mt-0.5 block whitespace-normal break-words text-xs leading-snug text-muted-foreground">{option.detail}</span> : null}
                    </span>
                    <Icon
                      name="Check"
                      className={`ml-auto size-4 shrink-0 ${option.value === value ? "opacity-100" : "opacity-0"}`}
                      aria-hidden
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface ProviderSettingsView {
  provider: SandboxProvider;
  enabled: boolean;
  configured: boolean;
  credentialsConfigured: boolean;
  apiUrl: string;
  target: string;
  sandboxClass: string;
  appName: string;
  vmRuntime: boolean;
  machineClass: string;
  environment: string;
  cpu: string;
  memory: string;
  storage: string;
  persistence: string;
  snapshotId: string;
  gatewayEndpoint: string;
  imageUri: string;
  supportsImages: boolean;
  artifactName: string | null;
}
interface DaytonaCapacityPool {
  regionId: string;
  regionName: string;
  regionType: string;
  sandboxClass: "container" | "linux-vm" | "windows";
  totalCpu: number;
  usedCpu: number;
  totalMemoryGiB: number;
  usedMemoryGiB: number;
  totalDiskGiB: number;
  usedDiskGiB: number;
  maxCpuPerSandbox: number | null;
  maxMemoryGiBPerSandbox: number | null;
  maxDiskGiBPerSandbox: number | null;
  maxLifespanMinutes: number | null;
}

interface DaytonaCapacityView {
  organizationId: string;
  pools: DaytonaCapacityPool[];
  refreshedAt: number;
}


interface ImageComponentGroup {
  category: string;
  items: string[];
}

type SandboxImageProvider = "daytona" | "modal" | "e2b" | "nirvana";

interface ImageSettingsView {
  repository: string;
  platform: string;
  registryUsernameConfigured: boolean;
  registryTokenConfigured: boolean;
  extraPackages: string[];
  components: ImageComponentGroup[];
  providers: {
    provider: SandboxImageProvider;
    credentialsConfigured: boolean;
    activeName: string | null;
    images: SandboxImageRecord[];
  }[];
}

function isImageBuildProgress(value: unknown): value is {
  provider: SandboxImageProvider | null;
  phase: "building" | "ready" | "error";
  message: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const provider = Reflect.get(value, "provider");
  const phase = Reflect.get(value, "phase");
  const message = Reflect.get(value, "message");
  return (
    (provider === null ||
      provider === "daytona" ||
      provider === "modal" ||
      provider === "e2b" ||
      provider === "nirvana") &&
    (phase === "building" || phase === "ready" || phase === "error") &&
    typeof message === "string"
  );
}

function providerLifecycleNote(provider: SandboxProvider): string {
  if (provider === "modal") {
    return "Modal runs continuously for its fixed 24-hour lifetime.";
  }
  if (provider === "box") return "Box archives on idle and resumes with its persistent machine state.";
  if (provider === "freestyle") return "Freestyle suspends on idle. Sticky disks are fast but may be evicted; persistent disks require a paid plan.";
  if (provider === "nirvana") return "Nirvana pauses compute while retaining the persistent workspace.";
  return provider === "daytona"
    ? "Daytona can stop after the configured idle period and wake on the next message."
    : "E2B can pause after the configured idle period and resume on demand.";
}

function ProviderSettingsCard({ provider }: { provider: SandboxProvider }) {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [view, setView] = useState<ProviderSettingsView | null>(null);
  const [vmRuntimeDraft, setVmRuntimeDraft] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [secondarySecretDraft, setSecondarySecretDraft] = useState("");
  const [apiUrlDraft, setApiUrlDraft] = useState("");
  const [targetDraft, setTargetDraft] = useState("");
  const [sandboxClassDraft, setSandboxClassDraft] = useState<
    "container" | "linux-vm" | "windows"
  >("container");
  const [appNameDraft, setAppNameDraft] = useState("bb-sandboxes");
  const [machineClassDraft, setMachineClassDraft] = useState("default");
  const [environmentDraft, setEnvironmentDraft] = useState("base");
  const [cpuDraft, setCpuDraft] = useState("4");
  const [memoryDraft, setMemoryDraft] = useState("8");
  const [storageDraft, setStorageDraft] = useState("20");
  const [persistenceDraft, setPersistenceDraft] = useState<"sticky" | "persistent">("sticky");
  const [snapshotIdDraft, setSnapshotIdDraft] = useState("");
  const [gatewayEndpointDraft, setGatewayEndpointDraft] = useState("");
  const [imageUriDraft, setImageUriDraft] = useState("node:22-bookworm-slim");
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [capacity, setCapacity] = useState<DaytonaCapacityView | null>(null);
  const [loadingCapacity, setLoadingCapacity] = useState(false);
  const [capacityError, setCapacityError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await rpc.call("providerSettings", null);
    const next = result.providers.find((item) => item.provider === provider);
    if (next === undefined)
      throw new Error(`${providerLabel(provider)} is unavailable`);
    setView(next);
    setApiUrlDraft(next.apiUrl);
    setTargetDraft(next.target);
    setAppNameDraft(next.appName || "bb-sandboxes");
    setSandboxClassDraft(
      next.sandboxClass === "linux-vm"
        ? "linux-vm"
        : next.sandboxClass === "windows"
          ? "windows"
          : "container",
    );
    setVmRuntimeDraft(next.vmRuntime);
    setMachineClassDraft(next.machineClass || "default");
    setEnvironmentDraft(next.environment || "base");
    setCpuDraft(next.cpu || "4");
    setMemoryDraft(next.memory || "8");
    setStorageDraft(next.storage || "20");
    setPersistenceDraft(next.persistence === "persistent" ? "persistent" : "sticky");
    setSnapshotIdDraft(next.snapshotId);
    setGatewayEndpointDraft(next.gatewayEndpoint);
    setImageUriDraft(next.imageUri || "node:22-bookworm-slim");
  }, [provider, rpc]);
  const refreshCapacity = useCallback(async () => {
    if (provider !== "daytona") return;
    setLoadingCapacity(true);
    setCapacityError(null);
    try {
      setCapacity(await rpc.call("daytonaCapacity", null));
    } catch (failure) {
      setCapacityError(errorText(failure));
    } finally {
      setLoadingCapacity(false);
    }
  }, [provider, rpc]);


  useEffect(() => {
    void load().catch((failure: unknown) => setError(errorText(failure)));
  }, [load]);
  useEffect(() => {
    if (provider === "daytona" && view?.credentialsConfigured === true) {
      void refreshCapacity();
    }
  }, [provider, refreshCapacity, view?.credentialsConfigured]);


  useRealtime(
    "sandbox-provider-settings",
    useCallback(() => {
      void load().catch(() => undefined);
    }, [load]),
  );

  if (view === null) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Icon name="Spinner" className="size-4 animate-spin" />
        Loading {providerLabel(provider)} settings
      </div>
    );
  }

  const saveConfiguration = async () => {
    setSavingConfiguration(true);
    setError(null);
    try {
      const next =
        provider === "daytona"
          ? await rpc.call("updateProviderConfiguration", {
              provider,
              ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft } : {}),
              apiUrl: apiUrlDraft,
              target: targetDraft,
              sandboxClass: sandboxClassDraft,
            })
          : provider === "modal"
            ? await rpc.call("updateProviderConfiguration", {
                provider,
                ...(apiKeyDraft.trim() ? { tokenId: apiKeyDraft } : {}),
                ...(secondarySecretDraft.trim()
                  ? { tokenSecret: secondarySecretDraft }
                  : {}),
                appName: appNameDraft,
                vmRuntime: vmRuntimeDraft,
              })
            : provider === "e2b"
              ? await rpc.call("updateProviderConfiguration", {
                  provider,
                  ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft } : {}),
                })
              : provider === "box"
                ? await rpc.call("updateProviderConfiguration", {
                    provider,
                    ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft } : {}),
                    machineClass: machineClassDraft === "small" || machineClassDraft === "large" ? machineClassDraft : "default",
                    environment: environmentDraft,
                  })
                : provider === "freestyle"
                  ? await rpc.call("updateProviderConfiguration", {
                      provider,
                      ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft } : {}),
                      cpu: cpuDraft, memory: memoryDraft, storage: storageDraft,
                      persistence: persistenceDraft,
                      snapshotId: snapshotIdDraft,
                    })
                  : await rpc.call("updateProviderConfiguration", {
                      provider,
                      ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft } : {}),
                      apiUrl: apiUrlDraft,
                      gatewayEndpoint: gatewayEndpointDraft,
                      imageUri: imageUriDraft,
                      cpu: cpuDraft, memory: memoryDraft, storage: storageDraft,
                    });
      setView(next);
      setApiKeyDraft("");
      setSecondarySecretDraft("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSavingConfiguration(false);
    }
  };
  const selectedCapacityPool =
    capacity?.pools.find(
      (pool) =>
        pool.regionId === targetDraft &&
        pool.sandboxClass === sandboxClassDraft,
    ) ?? null;


  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Icon name="Container" className="size-4" />
            <h2 className="text-sm font-medium">{providerLabel(provider)}</h2>
            <span className={view.configured ? "text-muted-foreground" : "text-destructive"}>
              {view.configured ? "Ready" : "Credential needed"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {providerLifecycleNote(provider)}
          </p>
        </div>
        <Switch
          checked={view.enabled}
          aria-label={`Enable ${providerLabel(provider)}`}
          onCheckedChange={(enabled) => {
            setView({ ...view, enabled });
            void rpc
              .call("setProviderEnabled", { provider, enabled })
              .then(setView, (failure: unknown) => {
                setView(view);
                setError(errorText(failure));
              });
          }}
        />
      </div>

      <div className="space-y-4 px-4 py-3">
      {view.enabled ? (
        <>
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-foreground">Provider connection</p>
              <p className="text-xs text-muted-foreground">Secrets are write-only. Leave a configured credential blank to keep it unchanged.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>{provider === "modal" ? "Token ID" : "API key"}</span>
                <Input
                  type="password"
                  value={apiKeyDraft}
                  placeholder={view.credentialsConfigured ? "[set]" : "[not set]"}
                  onChange={(event) => setApiKeyDraft(event.target.value)}
                />
              </label>
              {provider === "modal" ? (
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Token secret</span>
                  <Input
                    type="password"
                    value={secondarySecretDraft}
                    placeholder={view.credentialsConfigured ? "[set]" : "[not set]"}
                    onChange={(event) => setSecondarySecretDraft(event.target.value)}
                  />
                </label>
              ) : null}
              {provider === "box" ? (
                <>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Machine class</span>
                    <Input value={machineClassDraft} placeholder="small, default, or large" onChange={(event) => setMachineClassDraft(event.target.value)} />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Environment</span>
                    <Input value={environmentDraft} onChange={(event) => setEnvironmentDraft(event.target.value)} />
                  </label>
                </>
              ) : null}
              {provider === "freestyle" || provider === "nirvana" ? (
                <>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>CPU {provider === "freestyle" ? "cores" : "limit"}</span>
                    <Input value={cpuDraft} onChange={(event) => setCpuDraft(event.target.value)} />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Memory {provider === "freestyle" ? "(GB)" : "limit"}</span>
                    <Input value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Storage {provider === "freestyle" ? "(GB)" : "size"}</span>
                    <Input value={storageDraft} onChange={(event) => setStorageDraft(event.target.value)} />
                  </label>
                </>
              ) : null}
              {provider === "freestyle" ? (
                <>
                  <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
                    <span>Persistence mode</span>
                    <Select
                      value={persistenceDraft}
                      onValueChange={(value) => setPersistenceDraft(value === "persistent" ? "persistent" : "sticky")}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sticky">Sticky — supported on this plan; may eventually be evicted</SelectItem>
                        <SelectItem value="persistent">Persistent — retained until archive; paid plan required</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
                    <span>Bootstrap snapshot <span className="opacity-70">(recommended)</span></span>
                    <Input value={snapshotIdDraft} placeholder="Freestyle snapshot ID" onChange={(event) => setSnapshotIdDraft(event.target.value)} />
                  </label>
                </>
              ) : null}
              {provider === "nirvana" ? (
                <>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>API endpoint</span>
                    <Input value={apiUrlDraft} onChange={(event) => setApiUrlDraft(event.target.value)} />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Gateway endpoint</span>
                    <Input value={gatewayEndpointDraft} onChange={(event) => setGatewayEndpointDraft(event.target.value)} />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
                    <span>Container image</span>
                    <Input value={imageUriDraft} onChange={(event) => setImageUriDraft(event.target.value)} />
                  </label>
                </>
              ) : null}
              {provider === "daytona" ? (
                <>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>API URL <span className="opacity-70">(optional)</span></span>
                    <Input value={apiUrlDraft} onChange={(event) => setApiUrlDraft(event.target.value)} />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
                    <span>Capacity pool</span>
                    <Select
                      value={
                        targetDraft
                          ? `${targetDraft}|${sandboxClassDraft}`
                          : undefined
                      }
                      onValueChange={(value) => {
                        const [regionId, sandboxClass] = value.split("|");
                        setTargetDraft(regionId ?? "");
                        setSandboxClassDraft(
                          sandboxClass === "linux-vm"
                            ? "linux-vm"
                            : sandboxClass === "windows"
                              ? "windows"
                              : "container",
                        );
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={
                            loadingCapacity
                              ? "Loading capacity…"
                              : "Select a region and machine class"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {capacity?.pools.map((pool) => (
                          <SelectItem
                            key={`${pool.regionId}|${pool.sandboxClass}`}
                            value={`${pool.regionId}|${pool.sandboxClass}`}
                          >
                            {pool.regionName} · {pool.sandboxClass} ·{" "}
                            {pool.totalCpu - pool.usedCpu} cores available
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </>
              ) : null}
              {provider === "modal" ? (
                <>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>App name</span>
                    <Input value={appNameDraft} onChange={(event) => setAppNameDraft(event.target.value)} />
                  </label>
                  <label className="flex items-start justify-between gap-3 text-xs text-muted-foreground sm:col-span-2">
                    <span className="min-w-0">
                      <span className="block text-foreground">Modal VM runtime</span>
                      Modal's default gVisor runtime cannot run a Docker daemon. The full-VM runtime is Modal's recommended way to run Docker in a sandbox.
                    </span>
                    <Switch
                      checked={vmRuntimeDraft}
                      aria-label="Modal VM runtime"
                      onCheckedChange={setVmRuntimeDraft}
                    />
                  </label>
                </>
              ) : null}
            </div>
            {provider === "daytona" ? (
              <div className="space-y-2 rounded-md bg-muted/35 p-3 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-foreground">
                    Live capacity
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={loadingCapacity || !view.credentialsConfigured}
                    onClick={() => void refreshCapacity()}
                  >
                    {loadingCapacity ? "Refreshing…" : "Refresh"}
                  </Button>
                </div>
                {selectedCapacityPool === null ? (
                  <p className="text-muted-foreground">
                    Select a pool to inspect its aggregate quota and per-sandbox
                    maximums.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div>
                      <div className="text-muted-foreground">CPU</div>
                      <div className="font-medium text-foreground">
                        {selectedCapacityPool.usedCpu}/
                        {selectedCapacityPool.totalCpu} cores used
                      </div>
                      <div className="text-muted-foreground">
                        Max {selectedCapacityPool.maxCpuPerSandbox ?? "—"} per
                        sandbox
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Memory</div>
                      <div className="font-medium text-foreground">
                        {selectedCapacityPool.usedMemoryGiB}/
                        {selectedCapacityPool.totalMemoryGiB} GiB used
                      </div>
                      <div className="text-muted-foreground">
                        Max{" "}
                        {selectedCapacityPool.maxMemoryGiBPerSandbox ?? "—"} GiB
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Disk</div>
                      <div className="font-medium text-foreground">
                        {selectedCapacityPool.usedDiskGiB}/
                        {selectedCapacityPool.totalDiskGiB} GiB used
                      </div>
                      <div className="text-muted-foreground">
                        Max {selectedCapacityPool.maxDiskGiBPerSandbox ?? "—"}{" "}
                        GiB
                      </div>
                    </div>
                  </div>
                )}
                {capacityError !== null ? (
                  <p role="alert" className="text-destructive">
                    {capacityError}
                  </p>
                ) : null}
              </div>
            ) : null}
            <Button type="button" size="sm" variant="outline" disabled={savingConfiguration} onClick={() => void saveConfiguration()}>
              {savingConfiguration ? "Saving…" : `Save ${providerLabel(provider)} settings`}
            </Button>
          </div>

          <div className="grid gap-3 rounded-md bg-muted/35 p-3 text-xs sm:grid-cols-2">
            <div>
              <div className="text-muted-foreground">Credentials</div>
              <div className="mt-1 font-medium text-foreground">{view.credentialsConfigured ? "Configured" : "Not configured"}</div>
            </div>
            <div className="min-w-0">
              <div className="text-muted-foreground">Active image</div>
              <div className="mt-1 truncate font-mono text-foreground">
                {view.supportsImages ? (view.artifactName ?? "Not generated") : "Bootstrapped at launch"}
              </div>
            </div>
          </div>

          {view.supportsImages ? (
            <p className="text-xs text-muted-foreground">
              This provider pulls the shared sandbox image. Build and register it
              in the Sandbox image section above.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              This provider installs the bb runtime and agent toolchain during
              first boot instead of pulling the shared image.
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Disabled providers remain available for cleanup of existing threads,
          but cannot create new sandboxes.
        </p>
      )}

      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      </div>
    </section>
  );
}

function SandboxImageCard() {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [view, setView] = useState<ImageSettingsView | null>(null);
  const [repositoryDraft, setRepositoryDraft] = useState("");
  const [platformDraft, setPlatformDraft] = useState("");
  const [usernameDraft, setUsernameDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [packagesDraft, setPackagesDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildMessage, setBuildMessage] = useState<string | null>(null);
  const [activatingImageId, setActivatingImageId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await rpc.call("imageSettings", null);
    setView(next);
    setRepositoryDraft(next.repository);
    setPlatformDraft(next.platform);
    setPackagesDraft(next.extraPackages.join(", "));
  }, [rpc]);

  useEffect(() => {
    void load().catch((failure: unknown) => setError(errorText(failure)));
  }, [load]);

  useRealtime(
    "sandbox-provider-settings",
    useCallback(() => {
      void load().catch(() => undefined);
    }, [load]),
  );
  useRealtime(
    "sandbox-image-builds",
    useCallback(
      (payload) => {
        if (!isImageBuildProgress(payload)) return;
        setBuildMessage(
          payload.provider === null
            ? payload.message.trim()
            : `${providerLabel(payload.provider)}: ${payload.message.trim()}`,
        );
        if (payload.phase !== "building") void load().catch(() => undefined);
      },
      [load],
    ),
  );

  if (view === null) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Icon name="Spinner" className="size-4 animate-spin" />
        Loading sandbox image settings
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await rpc.call("updateImageConfiguration", {
        repository: repositoryDraft,
        platform: platformDraft,
        ...(usernameDraft.trim() ? { registryUsername: usernameDraft } : {}),
        ...(tokenDraft.trim() ? { registryToken: tokenDraft } : {}),
        packages: packagesDraft
          .split(/[\s,]+/u)
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setView(next);
      setRepositoryDraft(next.repository);
      setPackagesDraft(next.extraPackages.join(", "));
      setUsernameDraft("");
      setTokenDraft("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  const build = async () => {
    setBuilding(true);
    setBuildMessage("Preparing build context");
    setError(null);
    try {
      const result = await rpc.call("buildImage", {});
      setBuildMessage(
        `${result.pinnedReference} — ${result.registrations
          .map(
            (registration) =>
              `${providerLabel(registration.provider)} ${registration.status}`,
          )
          .join(", ")}`,
      );
      await load();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBuilding(false);
    }
  };

  const activate = async (image: SandboxImageRecord) => {
    setActivatingImageId(image.id);
    setError(null);
    try {
      await rpc.call("activateImage", { imageId: image.id });
      await load();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setActivatingImageId(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon name="Container" className="size-4" />
          <h2 className="text-sm font-medium">Sandbox image</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          One image is built here with Docker, pushed to your registry, and then
          referenced by Daytona, Modal, E2B, and Nirvana.
        </p>
      </div>

      <div className="space-y-4 px-4 py-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
            <span>Image repository</span>
            <Input
              value={repositoryDraft}
              placeholder="ghcr.io/acme/bb-sandbox"
              onChange={(event) => setRepositoryDraft(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Platform</span>
            <Input
              value={platformDraft}
              placeholder="linux/amd64"
              onChange={(event) => setPlatformDraft(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Registry username</span>
            <Input
              value={usernameDraft}
              placeholder={
                view.registryUsernameConfigured ? "[set]" : "[not set]"
              }
              onChange={(event) => setUsernameDraft(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
            <span>Registry token</span>
            <Input
              type="password"
              value={tokenDraft}
              placeholder={view.registryTokenConfigured ? "[set]" : "[not set]"}
              onChange={(event) => setTokenDraft(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
            <span>Additional Debian packages</span>
            <Input
              value={packagesDraft}
              placeholder="imagemagick, protobuf-compiler"
              onChange={(event) => setPackagesDraft(event.target.value)}
            />
          </label>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save image settings"}
        </Button>

        <div>
          <div className="text-sm font-medium text-foreground">
            Image contents
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {view.components.map((component) => (
              <div
                key={component.category}
                className="rounded-lg border border-border p-3"
              >
                <div className="text-xs font-medium text-foreground">
                  {component.category}
                </div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  {component.items.join(" · ")}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button
            type="button"
            disabled={view.repository.length === 0 || building}
            onClick={() => void build()}
          >
            {building ? (
              <Icon name="Spinner" className="mr-2 size-4 animate-spin" />
            ) : null}
            Build and register image
          </Button>
          {buildMessage !== null ? (
            <span
              role="status"
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            >
              {buildMessage}
            </span>
          ) : null}
        </div>
        {view.repository.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Set an image repository to enable builds.
          </p>
        ) : null}

        <div className="space-y-3">
          {view.providers.map((entry) => (
            <div key={entry.provider} className="rounded-md bg-muted/35 p-3">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="font-medium text-foreground">
                  {providerLabel(entry.provider)}
                </span>
                <span className="text-muted-foreground">
                  {entry.credentialsConfigured
                    ? "Credentials configured"
                    : "No credentials"}
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-xs text-foreground">
                {entry.activeName ?? "Not registered"}
              </div>
              {entry.images.length > 1 ? (
                <div className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                  {entry.images.slice(0, 4).map((image) => (
                    <div
                      key={image.id}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="truncate">{image.name}</span>
                      {image.isDefault ? (
                        <span>active</span>
                      ) : image.status === "ready" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={activatingImageId !== null}
                          onClick={() => void activate(image)}
                        >
                          {activatingImageId === image.id
                            ? "Activating…"
                            : "Use"}
                        </Button>
                      ) : (
                        <span>{image.status}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          A private repository works with Daytona, Modal, and E2B: the
          credentials saved here are passed to Modal and E2B per build, and
          registered as a Daytona organization registry automatically. Nirvana
          pulls with cluster credentials, so it needs an image pull secret
          configured on the Nirvana side.
        </p>

        {error !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function versionBadge(state: "current" | "behind" | "unknown"): {
  label: string;
  className: string;
} {
  if (state === "current") {
    return { label: "current", className: "text-muted-foreground" };
  }
  if (state === "behind") {
    return { label: "behind", className: "text-destructive" };
  }
  return { label: "unknown", className: "text-amber-500" };
}

const UPGRADE_POLL_MS = 3_000;
const UPGRADE_LOG_LINES = 300;

const machineActionClass: Record<
  NonNullable<SandboxUpgradeJobView["report"]>["machines"][number]["action"],
  string
> = {
  current: "text-muted-foreground",
  healed: "text-muted-foreground",
  "would-heal": "text-amber-500",
  skipped: "text-amber-500",
  unknown: "text-amber-500",
  failed: "text-destructive",
};

function imageActionText(image: NonNullable<SandboxUpgradeJobView["report"]>["image"]): string {
  if (image.action === "built") return `built and activated ${image.tag ?? ""}`.trim();
  if (image.action === "would-build") return `${image.reference ?? "?"} is behind; would build a new one`;
  if (image.action === "current") return `${image.reference ?? "?"} is current`;
  return "left alone";
}

/**
 * The one place to see whether the fleet matches the bb this machine runs:
 * active images and project pins with their bb-app, and the Update button.
 * Update runs `bb sandbox upgrade` as a job: build and activate a new image
 * when bb or a harness is behind, then heal every live and legacy machine.
 */
function SandboxUpgradesCard() {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [audit, setAudit] = useState<VersionAuditView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [job, setJob] = useState<SandboxUpgradeJobView | null>(null);
  const [jobLog, setJobLog] = useState<string[]>([]);
  const jobCursor = useRef(0);

  const load = useCallback(async () => {
    setAudit(await rpc.call("versionAudit", null));
  }, [rpc]);

  // With no id, reads the running or latest job so a reopened pane resumes it.
  const pollJob = useCallback(
    async (id: string | null) => {
      const next = await rpc.call("sandboxUpgradeJob", {
        id,
        cursor: id === null ? 0 : jobCursor.current,
      });
      if (next === null) {
        setJob(null);
        return;
      }
      jobCursor.current = next.cursor;
      setJobLog((current) =>
        (id === null ? next.progress : [...current, ...next.progress]).slice(-UPGRADE_LOG_LINES),
      );
      setJob(next);
      if (id !== null && next.state !== "running") void load().catch(() => undefined);
    },
    [rpc, load],
  );

  useEffect(() => {
    void load().catch((failure: unknown) => setError(errorText(failure)));
    void pollJob(null).catch(() => undefined);
  }, [load, pollJob]);
  // Each poll sets a new job, which schedules the next poll while it runs.
  useEffect(() => {
    if (job?.state !== "running") return;
    const timer = setTimeout(() => {
      void pollJob(job.id).catch((failure: unknown) => setError(errorText(failure)));
    }, UPGRADE_POLL_MS);
    return () => clearTimeout(timer);
  }, [job, pollJob]);

  const startUpdate = async () => {
    setError(null);
    setMessage(null);
    try {
      const { id } = await rpc.call("startSandboxUpgrade", {});
      jobCursor.current = 0;
      setJobLog([]);
      await pollJob(id);
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  useRealtime(
    "sandbox-version-audit",
    useCallback(() => {
      void load().catch(() => undefined);
    }, [load]),
  );

  const run = async (key: string, action: () => Promise<string>) => {
    setBusyAction(key);
    setError(null);
    try {
      setMessage(await action());
      await load();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusyAction(null);
    }
  };

  if (audit === null) {
    return (
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <Icon name="Spinner" className="size-4 animate-spin" />
          {error ?? "Checking sandbox versions"}
        </div>
      </section>
    );
  }

  const errors = audit.findings.filter((finding) => finding.severity === "error");
  const warnings = audit.findings.length - errors.length;
  const updating = job?.state === "running";
  const report = job?.report ?? null;

  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card"
      aria-label="Sandbox upgrades"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">bb {audit.serverVersion}</h2>
          <p className="text-xs text-muted-foreground">
            {audit.previousServerVersion !== null
              ? `Upgraded from ${audit.previousServerVersion}. `
              : ""}
            {errors.length > 0
              ? `${errors.length} item${errors.length === 1 ? "" : "s"} will not connect until fixed.`
              : warnings > 0
                ? `${warnings} item${warnings === 1 ? "" : "s"} have no recorded bb-app version yet.`
                : "Images and pins match this bb."}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={updating || busyAction !== null}
          onClick={() => void startUpdate()}
        >
          {updating ? (
            <>
              <Icon name="Spinner" className="size-4 animate-spin" />
              Updating…
            </>
          ) : (
            "Update"
          )}
        </Button>
      </div>
      <div className="space-y-3 px-4 py-3 text-sm">
        {audit.images.length > 0 ? (
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Active images
            </div>
            {audit.images.map((image) => {
              const badge = versionBadge(image.state);
              return (
                <div key={image.imageId} className="flex items-center justify-between gap-3">
                  <span className="truncate">
                    {providerLabel(image.provider)} · {image.name}
                  </span>
                  <span className={`shrink-0 text-xs ${badge.className}`}>
                    {image.bbAppVersion ?? "?"} · {badge.label}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
        {audit.pins.length > 0 ? (
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Project pins
            </div>
            {audit.pins.map((pin) => {
              const badge = versionBadge(pin.state);
              const key = `pin:${pin.projectId}:${pin.provider}`;
              return (
                <div key={key} className="flex items-center justify-between gap-3">
                  <span className="truncate">
                    {pin.projectId} · {providerLabel(pin.provider)} · {pin.imageName}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    <span className={badge.className}>
                      {pin.bbAppVersion ?? "?"} · {badge.label}
                    </span>
                    {pin.state !== "current" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busyAction !== null}
                        onClick={() =>
                          void run(key, async () => {
                            await rpc.call("clearProjectImage", {
                              projectId: pin.projectId,
                              provider: pin.provider,
                            });
                            return `${pin.projectId} now uses the shared ${providerLabel(pin.provider)} image.`;
                          })
                        }
                      >
                        {busyAction === key ? "Clearing…" : "Clear pin"}
                      </Button>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
        {job !== null ? (
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {updating ? "Updating" : report?.check === true ? "Last check" : "Last update"}
            </div>
            {job.state === "error" ? (
              <p className="text-xs text-destructive">{job.error ?? "The update failed."}</p>
            ) : job.state === "ready" ? (
              <p className="text-xs text-muted-foreground">
                {report?.check === true ? "Check finished; nothing was changed." : "Everything is up to date."}
              </p>
            ) : null}
            {report !== null ? (
              <div className="flex items-center justify-between gap-3">
                <span className="truncate">Image</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {imageActionText(report.image)}
                  {report.image.runUrl !== null ? (
                    <>
                      {" · "}
                      <a
                        className="underline"
                        href={report.image.runUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        build
                      </a>
                    </>
                  ) : null}
                </span>
              </div>
            ) : null}
            {report?.machines.map((machine) => (
              <div key={machine.hostId} className="flex items-center justify-between gap-3">
                <span className="truncate" title={machine.message ?? undefined}>
                  {machine.name}
                </span>
                <span className={`shrink-0 text-xs ${machineActionClass[machine.action]}`}>
                  {machine.versions?.bb != null ? `bb ${machine.versions.bb} · ` : ""}
                  {machine.action}
                </span>
              </div>
            ))}
            {jobLog.length > 0 ? (
              <details open={updating} className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  {updating ? jobLog[jobLog.length - 1] : "Log"}
                </summary>
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px] leading-4 text-muted-foreground">
                  {jobLog.join("\n")}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}
        {message !== null ? (
          <p role="status" className="text-xs text-muted-foreground">
            {message}
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ProviderSettings() {
  return (
    <div className="space-y-4">
      <SandboxUpgradesCard />
      <SandboxImageCard />
      <ProviderSettingsCard provider="daytona" />
      <ProviderSettingsCard provider="modal" />
      <ProviderSettingsCard provider="e2b" />
      <ProviderSettingsCard provider="box" />
      <ProviderSettingsCard provider="freestyle" />
      <ProviderSettingsCard provider="nirvana" />
    </div>
  );
}



const GIB = 1024 ** 3;

function resourcePercent(used: number | null, total: number | null): number | null {
  return used === null || total === null || total <= 0
    ? null
    : (used / total) * 100;
}

function resourceSeverity(percentages: Array<number | null>): "normal" | "warning" | "critical" {
  const highest = Math.max(0, ...percentages.filter((value): value is number => value !== null));
  if (highest >= 90) return "critical";
  if (highest >= 75) return "warning";
  return "normal";
}

function formatGib(bytes: number | null): string {
  if (bytes === null) return "—";
  const value = bytes / GIB;
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function runtimeResourceLabel(view: SandboxThreadResourcesView): string | null {
  if (view.state === "sleeping") return "Sleeping";
  if (view.state === "sleeping_pending") return "Sleeping…";
  if (view.state === "waking") return "Waking…";
  if (view.state === "resizing") return "Resizing…";
  if (view.state === "unavailable" || view.sampleError !== null) return "Unavailable";
  if (view.stale) return "Stale";
  return null;
}

function resourceTone(percent: number | null): {
  bar: string;
  text: string;
} {
  if (percent !== null && percent >= 90) {
    return { bar: "bg-destructive", text: "text-destructive" };
  }
  if (percent !== null && percent >= 75) {
    return { bar: "bg-warning", text: "text-warning" };
  }
  return { bar: "bg-foreground/60", text: "text-foreground" };
}

function ResourceMetric({
  icon,
  label,
  value,
  percent,
}: {
  icon: IconName;
  label: string;
  value: string;
  percent: number | null;
}) {
  const tone = resourceTone(percent);
  const bounded = Math.min(100, Math.max(0, percent ?? 0));
  return (
    <div className="min-w-0 rounded-lg bg-muted/35 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon name={icon} className="size-3.5 shrink-0" />
        <span className="whitespace-nowrap">{label}</span>
      </div>
      <div className={`mt-1 truncate text-sm font-medium tabular-nums ${tone.text}`}>
        {value}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={`h-full rounded-full ${tone.bar}`}
          style={{ width: `${bounded}%` }}
        />
      </div>
    </div>
  );
}

type SandboxHealth = "healthy" | "degraded" | "dead";

function sandboxHealth(
  view: SandboxThreadResourcesView,
  severity: ReturnType<typeof resourceSeverity>,
): SandboxHealth {
  if (view.state === "unavailable" || view.state === "destroyed") return "dead";
  if (
    runtimeResourceLabel(view) !== null ||
    view.sampleError !== null ||
    view.assessment?.state === "underprovisioned" ||
    severity !== "normal"
  ) {
    return "degraded";
  }
  return "healthy";
}

function SandboxHealthIcon({ health }: { health: SandboxHealth }) {
  const badge = {
    healthy: "CircleCheck",
    degraded: "AlertTriangle",
    dead: "CircleX",
  } satisfies Record<SandboxHealth, IconName>;
  return (
    <span className="relative inline-flex size-4 items-center justify-center" aria-hidden="true">
      <Icon name="Laptop" className="size-4" />
      <span className="absolute -bottom-0.5 -right-0.5 flex size-2.5 items-center justify-center rounded-full bg-background">
        <Icon name={badge[health]} className="size-2.5" />
      </span>
    </span>
  );
}

function LaunchMultiSelect({
  label,
  placeholder = "None",
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  placeholder?: string;
  options: Array<{
    id: string;
    name: string;
    description?: string;
    group?: { id: string; name: string };
  }>;
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = options.filter((option) =>
    option.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const needle = query.trim().toLowerCase();
  const grouped = options.some((option) => option.group !== undefined);
  const groups = new Map<
    string,
    { id: string; name: string; children: typeof options }
  >();
  if (grouped) {
    for (const option of options) {
      const group = option.group ?? { id: "ungrouped", name: "Other skills" };
      const entry = groups.get(group.id) ?? { ...group, children: [] };
      entry.children.push(option);
      groups.set(group.id, entry);
    }
  }
  const visibleGroups = [...groups.values()].filter(
    (group) =>
      group.name.toLowerCase().includes(needle) ||
      group.children.some((option) =>
        option.name.toLowerCase().includes(needle),
      ),
  );
  const optionRow = (option: (typeof options)[number], nested = false) => (
    <CommandItem
      key={option.id}
      value={option.id}
      aria-label={option.name}
      className={`min-h-8 text-xs data-[selected=true]:bg-state-hover data-[selected=true]:text-foreground ${nested ? "pl-8" : ""}`}
      disabled={disabled}
      onSelect={() =>
        onChange(
          value.includes(option.id)
            ? value.filter((id) => id !== option.id)
            : [...value, option.id],
        )
      }
    >
      <span className="min-w-0 flex-1">
        <span className="block">{option.name}</span>
        {option.description ? (
          <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {option.description}
          </span>
        ) : null}
      </span>
      <span
        role="checkbox"
        aria-checked={value.includes(option.id)}
        aria-label={option.name}
        className="flex size-4 shrink-0 items-center justify-center"
      >
        <Icon
          name="Check"
          className={`size-3.5 ${value.includes(option.id) ? "opacity-100" : "opacity-0"}`}
          aria-hidden
        />
      </span>
    </CommandItem>
  );
  const selected = options.filter((option) => value.includes(option.id));
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={`${label}: ${selected.length} selected`}
            className="h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-2.5 text-left text-sm"
          >
            <span className="min-w-0 flex-1 truncate">
              {selected.length
                ? selected.map((item) => item.name).join(", ")
                : placeholder}
            </span>
            {selected.length > 1 ? (
              <span className="text-xs text-muted-foreground">
                {selected.length}
              </span>
            ) : null}
            <Icon name="ChevronDown" className="size-4 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          mobileTitle={label}
          className="w-full md:w-[var(--radix-popover-trigger-width)] md:max-w-[calc(100vw-2rem)] md:p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              className="min-w-0 text-xs"
              value={query}
              onValueChange={setQuery}
              placeholder={`Search ${label.toLowerCase()}…`}
            />
            <CommandList
              aria-label={label}
              className="max-h-[min(24rem,calc(var(--radix-popover-content-available-height,80vh)-2.75rem))] overscroll-contain p-1"
            >
              <CommandEmpty>No options found.</CommandEmpty>
              {grouped ? (
                visibleGroups.map((group) => {
                  const childIds = new Set(
                    group.children.map((option) => option.id),
                  );
                  const count = group.children.filter((option) =>
                    value.includes(option.id),
                  ).length;
                  const checked = count === group.children.length;
                  const expanded =
                    needle.length > 0 || expandedGroups.includes(group.id);
                  const children = group.name.toLowerCase().includes(needle)
                    ? group.children
                    : group.children.filter((option) =>
                        option.name.toLowerCase().includes(needle),
                      );
                  return (
                    <CommandGroup key={group.id} className="p-0">
                      <CommandItem
                        disabled={disabled}
                        value={`catalog:${group.id}`}
                        aria-label={group.name}
                        className="min-h-8 gap-2 text-xs font-medium data-[selected=true]:bg-state-hover data-[selected=true]:text-foreground"
                        onSelect={() =>
                          onChange(
                            checked
                              ? value.filter((id) => !childIds.has(id))
                              : [...new Set([...value, ...childIds])],
                          )
                        }
                      >
                        <button
                          type="button"
                          className="-my-1 -ml-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-state-active hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                          aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`}
                          aria-expanded={expanded}
                          disabled={needle.length > 0}
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedGroups((current) =>
                              current.includes(group.id)
                                ? current.filter((id) => id !== group.id)
                                : [...current, group.id],
                            );
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ")
                              event.stopPropagation();
                          }}
                        >
                          <Icon
                            name={expanded ? "ChevronDown" : "ChevronRight"}
                            className="size-3.5"
                            aria-hidden
                          />
                        </button>
                        <span className="min-w-0 flex-1 truncate">
                          {group.name}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {count}/{group.children.length}
                        </span>
                        <span
                          role="checkbox"
                          aria-checked={
                            checked ? true : count > 0 ? "mixed" : false
                          }
                          aria-label={group.name}
                          className="flex size-4 shrink-0 items-center justify-center"
                        >
                          {count > 0 && !checked ? (
                            <span
                              aria-hidden
                              className="h-px w-2.5 bg-current"
                            />
                          ) : (
                            <Icon
                              name="Check"
                              className={`size-3.5 ${checked ? "opacity-100" : "opacity-0"}`}
                              aria-hidden
                            />
                          )}
                        </span>
                      </CommandItem>
                      {expanded
                        ? children.map((option) => optionRow(option, true))
                        : null}
                    </CommandGroup>
                  );
                })
              ) : (
                <CommandGroup>
                  {matches.map((option) => optionRow(option))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}


function SandboxAttachments({
  threadId,
  live,
}: {
  threadId: string;
  live: boolean;
}) {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [view, setView] = useState<AttachmentsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<AttachmentChange | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const load = useCallback(async () => {
    const next = await rpc.call("threadAttachments", { threadId });
    setView(next);
    if (next.operation?.state !== "applying") setPending(null);
    setError(null);
  }, [rpc, threadId]);
  useEffect(() => {
    if (!live) {
      setError(null);
      return;
    }
    void load().catch((e) => setError(errorText(e)));
  }, [load, live]);
  const applying =
    submitting || pending !== null || view?.operation?.state === "applying";
  useEffect(() => {
    if (!applying) return;
    const timer = window.setInterval(
      () =>
        void load().catch((e) => {
          setError(errorText(e));
          setPending(null);
        }),
      2000,
    );
    return () => window.clearInterval(timer);
  }, [applying, load]);
  useRealtime(
    "sandboxes",
    useCallback((payload) => {
      if ((payload as { type?: string } | null)?.type === "changed" && live && !submitting) {
        void load().catch((e) => setError(errorText(e)));
      }
    }, [load, live, submitting]),
  );
  const update = async (change: AttachmentChange) => {
    if (applying) return;
    setSubmitting(true);
    setPending(change);
    setError(null);
    try {
      await rpc.call("updateThreadAttachments", { threadId, change });
      await load();
    } catch (e) {
      setError(errorText(e));
      setPending(null);
    } finally {
      setSubmitting(false);
    }
  };
  const displayed =
    pending ??
    (view?.operation?.state === "applying" ? view.operation.change : null);
  const ids = (
    kind: "auth" | "tools" | "skills" | "agents",
    current: string[],
  ) => (displayed?.kind === kind ? displayed.ids : current);
  const disabled = applying || !live;
  return (
    <div className="space-y-3 border-t border-border pt-3" aria-busy={applying}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Attached to this machine</span>
        {applying ? (
          <span
            role="status"
            className="flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Icon name="Spinner" className="size-3 animate-spin" />
            Applying…
          </span>
        ) : null}
      </div>
      {view ? (
        <>
          <LaunchMultiSelect
            label="Pre-authentication"
            options={[
              { id: "github", name: "GitHub CLI" },
              { id: "subscription", name: "OMP, Claude Code, Codex" },
            ]}
            value={ids("auth", view.authIds ?? [])}
            placeholder={
              view.authIds === null ? "Unavailable while offline" : "None"
            }
            disabled={disabled}
            onChange={(ids) =>
              void update({
                kind: "auth",
                ids: ids as ("github" | "subscription")[],
              })
            }
          />
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">
              Credential set
            </div>
            <SearchablePicker
              label="Credential set"
              icon="Lock"
              placeholder="None"
              searchPlaceholder="Search credentials…"
              emptyMessage="No credential sets found."
              options={[
                { value: "none", label: "None", icon: "Lock" },
                ...view.credentials.map((item) => ({
                  value: item.id,
                  label: item.name,
                  icon: "Lock" as IconName,
                })),
              ]}
              value={
                (displayed?.kind === "credentials"
                  ? displayed.id
                  : view.credentialProfileId) ?? "none"
              }
              disabled={disabled}
              onChange={(id) =>
                void update({
                  kind: "credentials",
                  id: id === "none" ? null : id,
                })
              }
            />
          </div>
          <LaunchMultiSelect
            label="Project tools and CLIs"
            options={view.tools}
            value={ids("tools", view.toolIds)}
            disabled={disabled}
            onChange={(ids) => void update({ kind: "tools", ids })}
          />
          <LaunchMultiSelect
            label="Skills"
            options={view.skills.map((item) => ({
              ...item,
              group: {
                id: item.sourceId ?? "other",
                name: item.sourceName ?? "Other skills",
              },
            }))}
            value={ids("skills", view.skillIds)}
            disabled={disabled}
            onChange={(ids) => void update({ kind: "skills", ids })}
          />
          <LaunchMultiSelect
            label="Agents"
            options={view.agents}
            value={ids("agents", view.agentIds)}
            disabled={disabled}
            onChange={(ids) => void update({ kind: "agents", ids })}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {live
              ? "Machine files update immediately. Existing agent sessions pick up changed context when restarted."
              : "Wake and reconnect this machine to change its attachments."}
          </p>
        </>
      ) : !error ? (
        <p role="status" className="text-xs text-muted-foreground">
          {live ? "Loading attachments…" : "Attachments available when the machine wakes."}
        </p>
      ) : null}
      {live && (error || view?.operation?.state === "failed") ? (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5"
        >
          <p className="text-xs text-destructive">
            {error ?? view?.operation?.error}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={applying || !live}
            onClick={() => {
              if (view?.operation?.state === "failed")
                void update(view.operation.change);
              else void load().catch((e) => setError(errorText(e)));
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SandboxAlwaysOn({ threadId, separated }: { threadId: string; separated: boolean }) {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await rpc.call("sandboxAlwaysOn", { threadId });
    setEnabled(result.enabled);
  }, [rpc, threadId]);
  useEffect(() => {
    void load().catch((failure) => setError(errorText(failure)));
  }, [load]);
  useRealtime("sandboxes", useCallback((payload) => {
    if ((payload as { type?: string } | null)?.type === "always-on-changed" && !saving) {
      void load().catch((failure) => setError(errorText(failure)));
    }
  }, [load, saving]));

  if (enabled === null && error === null) return null;
  return (
    <div className={separated ? "space-y-1 border-t border-border pt-3" : "space-y-1"}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="sandbox-always-on" className="text-xs font-medium">Always on</label>
        <Switch
          id="sandbox-always-on"
          aria-label="Always on"
          checked={enabled ?? false}
          disabled={enabled === null || saving}
          onCheckedChange={(next) => {
            setSaving(true);
            setError(null);
            void rpc.call("setSandboxAlwaysOn", { threadId, enabled: next })
              .then((result) => setEnabled(result.enabled))
              .catch((failure) => {
                setError(errorText(failure));
                void load().catch(() => undefined);
              })
              .finally(() => setSaving(false));
          }}
        />
      </div>
      {error !== null ? <p role="alert" className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * The thread's Model Gateway route, or null without one. Polled, because
 * Gateway's realtime events reach only Gateway's own UI.
 */
function useModelRoute(threadId: string) {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [state, setState] = useState<{ threadId: string; route: ModelRoute | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    const load = () => {
      void rpc.call("threadModelRoute", { threadId }).then(
        (route) => { if (current) setState({ threadId, route }); },
        () => { if (current) setState({ threadId, route: null }); },
      );
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [rpc, threadId, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { route: state?.threadId === threadId ? state.route : null, reload };
}

/** Match the model picker labels; preserve unknown custom IDs. */
function modelName(model: string): string {
  const bare = model.replace(/^(?:model-gateway|openai-codex|openai|anthropic)\//u, "").replace(/^gw-/u, "");
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-(astra|sol|luna|terra|codex-spark))?$/u.exec(bare);
  if (gpt) return `${gpt[1]}${gpt[2] ? `-${gpt[2] === "codex-spark" ? "Spark" : gpt[2][0]!.toUpperCase() + gpt[2].slice(1)}` : ""}`;
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/u.exec(bare);
  if (claude === null) return model;
  const [, family = "", major = "", minor] = claude;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor === undefined ? "" : `.${minor}`}`;
}

function routeStep(route: ModelRoute): string {
  return route.chain[route.chainIndex] ?? route.accountLabel ?? "Gateway";
}

function routeSummary(route: ModelRoute): string {
  const model = route.autoModel ?? route.model;
  return `${model === null ? "Unknown model" : modelName(model)} on ${routeStep(route)}${route.chainIndex > 0 ? " (fallback)" : ""}`;
}

const FALLBACK_REASONS: Record<string, string> = {
  "rate-limit": "hit its limit",
  authentication: "rejected the login",
  transport: "could not be reached",
  availability: "was unavailable",
};

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Amber dot on the header icon while the thread runs on a fallback step. */
function FallbackDot({ route }: { route: ModelRoute | null }) {
  if (route === null || route.chainIndex === 0) return null;
  return <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-warning" />;
}

function ModelRouteSection({ route, separated }: { route: ModelRoute; separated: boolean }) {
  const step = routeStep(route);
  const model = route.autoModel ?? route.model;
  const fallback = route.chainIndex > 0;
  const cause = route.fallbackCause;
  return (
    <div className={separated ? "space-y-1 border-t border-border pt-3" : "space-y-1"}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium">Model</div>
        {fallback ? (
          <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] text-warning">Fallback</span>
        ) : route.autoModel !== null ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Jev pick</span>
        ) : null}
      </div>
      <div className="text-sm" title={model ?? undefined}>{model === null ? "Unknown model" : modelName(model)}</div>
      <div className="text-[11px] text-muted-foreground">
        {step}{route.accountLabel !== null && route.accountLabel !== step ? ` · ${route.accountLabel}` : ""}
      </div>
      {route.chain.length > 1 ? (
        <div className="text-[11px] text-muted-foreground">
          Route:{" "}
          {route.chain.map((entry, index) => (
            <Fragment key={index}>
              {index > 0 ? " → " : ""}
              <span className={index === route.chainIndex ? "font-medium text-foreground" : undefined}>{entry}</span>
            </Fragment>
          ))}
        </div>
      ) : null}
      {fallback && cause !== null ? (
        <p className="text-[11px] text-warning" title={cause.message}>
          {cause.upstreamLabel} {FALLBACK_REASONS[cause.category] ?? "failed"} (HTTP {cause.status}) at {clockTime(cause.at)}
        </p>
      ) : null}
      {fallback && route.stickyUntil !== null ? (
        <p className="text-[11px] text-muted-foreground">Stays on {step} until {clockTime(route.stickyUntil)}</p>
      ) : null}
      {route.auto !== null ? <p className="text-[11px] text-muted-foreground">Jev: {route.auto}</p> : null}
    </div>
  );
}

const HEADER_BUTTON_CLASS =
  "relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function MachineActionItems({ thread, onRun }: { thread: PluginThreadActionTarget; onRun(): void }) {
  const actions = experimental_useThreadActions(thread, { keys: ["workspace-scripts/scripts"] });
  if (actions.length === 0) return null;
  return <div className="border-t border-border pt-2">
    {actions.map(({ key, action }) => <Button key={key} variant="ghost" size="sm" className="w-full justify-start gap-2" disabled={action.disabled}
      onClick={() => { onRun(); void action.run(); }}>
      <AppIcon name={action.icon} className="size-3.5" />
      {action.label}
    </Button>)}
  </div>;
}

function MachineThreadActions({ threadId, onRun }: { threadId: string; onRun(): void }) {
  const { threads } = experimental_useSidebarThreads();
  const thread = threads.find((entry) => entry.id === threadId);
  if (!thread) return null;
  return <MachineActionItems thread={{ ...thread, environment: thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null }} onRun={onRun} />;
}

function SandboxResourceIndicator({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [view, setView] = useState<SandboxThreadResourcesView | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [cpu, setCpu] = useState("");
  const [memory, setMemory] = useState("");
  const [disk, setDisk] = useState("");
  const { route, reload: reloadRoute } = useModelRoute(threadId);

  const load = useCallback(async (refresh: boolean) => {
    const next = await rpc.call("threadResources", { threadId, refresh });
    setView(next);
    setError(null);
  }, [rpc, threadId]);

  useEffect(() => {
    void load(true).catch((failure) => setError(errorText(failure)));
  }, [load]);

  // Only sandbox threads have meters worth refreshing, by poll or realtime;
  // everything else costs a single call per thread.
  const managed = view?.managed === true;
  useEffect(() => {
    if (!managed) return;
    const timer = window.setInterval(() => {
      void load(true).catch((failure) => setError(errorText(failure)));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load, managed]);

  useRealtime(
    "sandboxes",
    useCallback(() => {
      if (!managed) return;
      void load(false).catch(() => undefined);
    }, [load, managed]),
  );

  useEffect(() => {
    if (view?.managed !== true) return;
    const provisioned = view.provisioned;
    setCpu(provisioned?.cpuCores === null || provisioned?.cpuCores === undefined ? "" : String(provisioned.cpuCores));
    setMemory(provisioned?.memoryBytes === null || provisioned?.memoryBytes === undefined ? "" : String(Math.ceil(provisioned.memoryBytes / GIB)));
    setDisk(provisioned?.diskBytes === null || provisioned?.diskBytes === undefined ? "" : String(Math.ceil(provisioned.diskBytes / GIB)));
  }, [view?.managed, view?.provisioned?.cpuCores, view?.provisioned?.memoryBytes, view?.provisioned?.diskBytes]);

  if (view?.managed !== true) {
    const summary = route === null ? null : routeSummary(route);
    return <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) reloadRoute(); }}>
      <PopoverTrigger asChild>
        <button type="button" className={HEADER_BUTTON_CLASS}
          aria-label={view === null ? "Loading machine status" : summary ? `Local machine. ${summary}. Open model and machine details` : "Local machine"}
          title={summary ? `Local machine · ${summary}` : "Local machine"}>
          <Icon name="Laptop" className="size-4" />
          {route === null ? null : <FallbackDot route={route} />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-full space-y-3 md:w-[20rem]" mobileTitle="Machine">
        {route === null ? null : <ModelRouteSection route={route} separated={false} />}
        <div className={`flex items-center gap-1.5 text-[11px] text-muted-foreground${route === null ? "" : " border-t border-border pt-3"}`}>
          <Icon name="Laptop" className="size-3.5" />Local machine
        </div>
        <MachineThreadActions threadId={threadId} onRun={() => setOpen(false)} />
      </PopoverContent>
    </Popover>;
  }

  const sample = view.latest;
  const memoryTotal = sample?.memoryBytes ?? view.provisioned?.memoryBytes ?? null;
  const diskTotal = sample?.diskBytes ?? view.provisioned?.diskBytes ?? null;
  const memoryPercent = resourcePercent(sample?.memoryUsageBytes ?? null, memoryTotal);
  const diskPercent = resourcePercent(sample?.diskUsageBytes ?? null, diskTotal);
  const severity = resourceSeverity([
    sample?.cpuUsagePercent ?? null,
    memoryPercent,
    diskPercent,
  ]);
  const stateLabel = runtimeResourceLabel(view);
  const health = sandboxHealth(view, severity);
  const healthLabel = `Sandbox ${health}`;
  const fullLabel = stateLabel ?? (
    sample === null
      ? "Resources unavailable"
      : `CPU ${sample.cpuUsagePercent === null ? "—" : `${sample.cpuUsagePercent.toFixed(0)}%`} · RAM ${formatGib(sample.memoryUsageBytes)}/${formatGib(memoryTotal)} GiB · Disk ${formatGib(sample.diskUsageBytes)}/${formatGib(diskTotal)} GiB`
  );
  const currentCpu = view.provisioned?.cpuCores;
  const currentMemory = view.provisioned?.memoryBytes;
  const currentDisk = view.provisioned?.diskBytes;
  const cpuValue = Number(cpu);
  const memoryBytes = Number(memory) * GIB;
  const diskBytes = Number(disk) * GIB;
  const needsStop =
    (Number.isFinite(cpuValue) && currentCpu !== null && currentCpu !== undefined && cpuValue < currentCpu) ||
    (Number.isFinite(memoryBytes) && currentMemory !== null && currentMemory !== undefined && memoryBytes < currentMemory) ||
    (Number.isFinite(diskBytes) && currentDisk !== null && currentDisk !== undefined && diskBytes !== currentDisk);
  const diskShrinks = Number.isFinite(diskBytes) && currentDisk !== null && currentDisk !== undefined && diskBytes < currentDisk;
  const hasChanges =
    (Number.isFinite(cpuValue) && currentCpu !== null && currentCpu !== undefined && cpuValue !== currentCpu) ||
    (Number.isFinite(memoryBytes) && currentMemory !== null && currentMemory !== undefined && memoryBytes !== currentMemory) ||
    (Number.isFinite(diskBytes) && currentDisk !== null && currentDisk !== undefined && diskBytes !== currentDisk);

  const submitResize = async () => {
    if (view.sandboxId === null) return;
    if (needsStop && !confirmStop) {
      setConfirmStop(true);
      return;
    }
    setResizing(true);
    setError(null);
    try {
      const result = await rpc.call("resizeSandbox", {
        sandboxId: view.sandboxId,
        ...(Number.isFinite(cpuValue) && cpuValue > 0 ? { cpuCores: cpuValue } : {}),
        ...(Number.isFinite(memoryBytes) && memoryBytes > 0 ? { memoryBytes } : {}),
        ...(Number.isFinite(diskBytes) && diskBytes > 0 ? { diskBytes } : {}),
      });
      if (!result.supported) setError(result.reason ?? "This provider cannot resize the existing sandbox");
      await load(true);
      setConfirmStop(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setResizing(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) reloadRoute(); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${healthLabel}. ${fullLabel}.${route === null ? "" : ` ${routeSummary(route)}.`} Open sandbox resource details`}
          title={`${healthLabel} · ${fullLabel}${route === null ? "" : `\n${routeSummary(route)}`}`}
          className={HEADER_BUTTON_CLASS}
        >
          <SandboxHealthIcon health={health} />
          <FallbackDot route={route} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-full space-y-3 md:w-[24rem] md:max-h-[var(--radix-popover-content-available-height)] overflow-y-auto" mobileTitle="Machine">
        {view.state === "live" ? <div className="grid grid-cols-3 gap-2">
          <ResourceMetric
            icon="Cpu"
            label="CPU"
            value={sample?.cpuUsagePercent === null || sample?.cpuUsagePercent === undefined ? "—" : `${sample.cpuUsagePercent.toFixed(0)}%`}
            percent={sample?.cpuUsagePercent ?? null}
          />
          <ResourceMetric
            icon="Memory"
            label="RAM"
            value={`${formatGib(sample?.memoryUsageBytes ?? null)} / ${formatGib(memoryTotal)} GiB`}
            percent={memoryPercent}
          />
          <ResourceMetric
            icon="HardDrive"
            label="Disk"
            value={`${formatGib(sample?.diskUsageBytes ?? null)} / ${formatGib(diskTotal)} GiB`}
            percent={diskPercent}
          />
        </div> : null}

        {view.provider !== "modal" ? <SandboxAlwaysOn threadId={threadId} separated={view.state === "live"} /> : null}
        {view.state === "live" ? <SandboxAttachments threadId={threadId} live /> : null}

        {view.capability === "supported" ? (
          <div className="space-y-2.5 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium">Resize</div>
              {needsStop ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] text-warning">
                  <Icon name="RotateCcw" className="size-3" />
                  Restarts sandbox
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="space-y-1 text-[11px] text-muted-foreground">CPU<Input aria-label="CPU cores" type="number" min="1" value={cpu} onChange={(event) => { setCpu(event.target.value); setConfirmStop(false); }} /></label>
              <label className="space-y-1 text-[11px] text-muted-foreground">RAM<Input aria-label="RAM GiB" type="number" min="1" value={memory} onChange={(event) => { setMemory(event.target.value); setConfirmStop(false); }} /></label>
              <label className="space-y-1 text-[11px] text-muted-foreground">Disk<Input aria-label="Disk GiB" type="number" min={currentDisk === null || currentDisk === undefined ? "1" : String(Math.ceil(currentDisk / GIB))} value={disk} onChange={(event) => { setDisk(event.target.value); setConfirmStop(false); }} /></label>
            </div>
            {diskShrinks ? <p role="alert" className="text-[11px] text-destructive">Disk can only grow · minimum {formatGib(currentDisk ?? null)} GiB</p> : null}
            {error !== null ? <p role="alert" className="text-[11px] text-destructive">{error}</p> : null}
            <Button type="button" size="sm" className="w-full" disabled={resizing || diskShrinks || !hasChanges} onClick={() => void submitResize()}>
              {resizing ? "Resizing…" : confirmStop ? "Confirm restart" : !hasChanges ? "Current size" : needsStop ? "Review resize" : "Resize"}
            </Button>
          </div>
        ) : null}
        {route !== null ? <ModelRouteSection route={route} separated /> : null}
        <MachineThreadActions threadId={threadId} onRun={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Machine size (S/M/L/XL) picker shown in the native New Thread composer. */
const SIZE_DEFAULT = "__default__";
function SandboxSizeInputs({ value, onChange }: PluginMachineProviderInputsProps) {
  const current =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? ((value as { size?: unknown }).size ?? null)
      : null;
  const selected = typeof current === "string" ? current : SIZE_DEFAULT;
  return (
    <Select
      value={selected}
      onValueChange={(next) => {
        onChange(
          next === SIZE_DEFAULT
            ? { status: "ready", value: {} }
            : { status: "ready", value: { size: next } },
        );
      }}
    >
      <SelectTrigger
        aria-label="Machine size"
        className="h-auto w-auto gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-sm font-normal text-muted-foreground shadow-none hover:bg-state-hover hover:text-foreground focus:ring-0"
      >
        <div className="inline-flex items-center gap-1.5">
          <Icon name="Cpu" className="size-3.5 shrink-0" />
          {selected === SIZE_DEFAULT ? "Default size" : `Size ${selected}`}
        </div>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SIZE_DEFAULT}>Project default</SelectItem>
        {sandboxSizeTierValues.map((tier) => (
          <SelectItem key={tier} value={tier}>
            {formatSizeTier(tier)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "providers",
    title: "Providers",
    description: "Enable the sandbox providers you use, configure their connection, and manage their images.",
    component: ProviderSettings,
  });
  app.slots.experimental_threadHeaderAction({
    id: "sandbox-resources",
    title: "Machine and model",
    component: SandboxResourceIndicator,
  });
  // Manual size override in the composer for every sandbox provider. Leaving it
  // on "Project default" applies the project's pinned size (resolved server-side).
  for (const provider of sandboxProviderValues) {
    app.slots.experimental_machineProviderInputs({
      machineProviderId: `sandbox-${provider}`,
      component: SandboxSizeInputs,
    });
  }
});
