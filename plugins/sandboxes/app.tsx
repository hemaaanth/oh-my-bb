import { imageTools, defaultImageTools, type ImageRecipe } from "./src/image-tools.js";
import { ImagePackageTags } from "./components/image-package-tags.js";
import type { AttachmentsView } from "./src/attachment-contract.js";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type PluginThreadHeaderActionProps,
  type PluginMachineProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import { SettingsDialog } from "./components/settings-dialog.js";
import { Button } from "./components/ui/button";
import { SandboxPreferencesSettings, SandboxIntegrationSettings, SandboxPreparationStatus } from "./components/sandbox-settings.js";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
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
    box: "Box by ASCII", freestyle: "Freestyle",
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


interface ProviderSettingsView {
  provider: SandboxProvider;
  enabled: boolean;
  configured: boolean;
  credentialsConfigured: boolean;
  credentialCheck: "missing" | "unchecked" | "valid" | "invalid";
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



type SandboxImageProvider = "daytona" | "modal" | "e2b";

interface ImageSettingsView {
  recipe: ImageRecipe;
  repository: string;
  platform: string;
  registryUsernameConfigured: boolean;
  registryTokenConfigured: boolean;
  extraPackages: string[];
  providers: {
    provider: SandboxImageProvider;
    credentialsConfigured: boolean;
    activeName: string | null;
    images: Array<SandboxImageRecord & { browserProvenance?: "verified" | "unknown" | "incompatible" }>;
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
      provider === "e2b") &&
    (phase === "building" || phase === "ready" || phase === "error") &&
    typeof message === "string"
  );
}

function providerLifecycleNote(provider: SandboxProvider): string {
  if (provider === "modal") {
    return "Runs for up to 24 hours; idle sleep does not apply.";
  }
  if (provider === "box") return "Archives on idle and resumes with saved machine state.";
  if (provider === "freestyle") return "Pauses on idle. Disk retention depends on the selected persistence mode.";
  return provider === "daytona"
    ? "Sleeps on idle and wakes on the next message."
    : "Pauses on idle and resumes on demand.";
}

function ProviderSettingsCard({ provider }: { provider: SandboxProvider }) {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [view, setView] = useState<ProviderSettingsView | null>(null);
  const [vmRuntimeDraft, setVmRuntimeDraft] = useState(false);
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
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [capacity, setCapacity] = useState<DaytonaCapacityView | null>(null);
  const [loadingCapacity, setLoadingCapacity] = useState(false);
  const [capacityError, setCapacityError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    const result = await rpc.call("providerSettings", null);
    if (id !== request.current) return;
    const next = result.providers.find((item) => item.provider === provider);
    if (next === undefined)
      throw new Error(`${providerLabel(provider)} is unavailable`);
    setView(next);
    if (dirty.current) return;
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
        {error ? <span role="alert">{error}</span> : <><Icon name="Spinner" className="size-4 animate-spin" />Loading {providerLabel(provider)} settings</>}
      </div>
    );
  }

  if (view.credentialCheck !== "valid") return <p role="status" className="text-sm text-muted-foreground">Check this provider’s connection in the provider list before editing its settings.</p>;

  const saveConfiguration = async () => {
    setSavingConfiguration(true);
    request.current++;
    setError(null);
    try {
      const next =
        provider === "daytona"
          ? await rpc.call("updateProviderConfiguration", {
              provider,
              apiUrl: apiUrlDraft,
              target: targetDraft,
              sandboxClass: sandboxClassDraft,
            })
          : provider === "modal"
            ? await rpc.call("updateProviderConfiguration", {
                provider,
                appName: appNameDraft,
                vmRuntime: vmRuntimeDraft,
              })
            : provider === "e2b"
              ? await rpc.call("updateProviderConfiguration", {
                  provider,
                })
              : provider === "box"
                ? await rpc.call("updateProviderConfiguration", {
                    provider,
                    machineClass: machineClassDraft === "small" || machineClassDraft === "large" ? machineClassDraft : "default",
                    environment: environmentDraft,
                  })
                : await rpc.call("updateProviderConfiguration", {
                    provider, cpu: cpuDraft, memory: memoryDraft, storage: storageDraft,
                    persistence: persistenceDraft, snapshotId: snapshotIdDraft,
                  });
      setView(next);
      dirty.current = false;
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
    <section className="min-w-0">
      <fieldset disabled={savingConfiguration} onChange={() => { dirty.current = true; }} className="min-w-0 space-y-4 py-1">
      <>
          <div className="space-y-3">
            <div className="@container grid min-w-0 grid-cols-1 gap-3">
              {provider === "box" ? (
                <>
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>Machine class</span>
                    <Input value={machineClassDraft} placeholder="small, default, or large" onChange={(event) => setMachineClassDraft(event.target.value)} />
                  </label>
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>Environment</span>
                    <Input value={environmentDraft} onChange={(event) => setEnvironmentDraft(event.target.value)} />
                  </label>
                </>
              ) : null}
              {provider === "freestyle" ? (
                <>
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>CPU {"cores"}</span>
                    <Input value={cpuDraft} onChange={(event) => setCpuDraft(event.target.value)} />
                  </label>
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>Memory {"(GB)"}</span>
                    <Input value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} />
                  </label>
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>Storage {"(GB)"}</span>
                    <Input value={storageDraft} onChange={(event) => setStorageDraft(event.target.value)} />
                  </label>
                </>
              ) : null}
              {provider === "freestyle" ? (
                <>
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>Persistence mode</span>
                    <Select
                      value={persistenceDraft}
                      onValueChange={(value) => { dirty.current = true; setPersistenceDraft(value === "persistent" ? "persistent" : "sticky"); }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sticky">Sticky — plan-default retention; may be deleted while idle</SelectItem>
                        <SelectItem value="persistent">Persistent — retained until archive; uncapped retention required</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>Bootstrap snapshot <span className="opacity-70">(recommended)</span></span>
                    <Input value={snapshotIdDraft} placeholder="Freestyle snapshot ID" onChange={(event) => setSnapshotIdDraft(event.target.value)} />
                  </label>
                </>
              ) : null}
              {provider === "daytona" ? (
                <>
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>API URL <span className="opacity-70">(optional)</span></span>
                    <Input value={apiUrlDraft} onChange={(event) => setApiUrlDraft(event.target.value)} />
                  </label>
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>Capacity pool</span>
                    <Select
                      value={
                        targetDraft
                          ? `${targetDraft}|${sandboxClassDraft}`
                          : undefined
                      }
                      onValueChange={(value) => {
                        dirty.current = true;
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
                        {targetDraft && !capacity?.pools.some(pool => pool.regionId === targetDraft && pool.sandboxClass === sandboxClassDraft) ?
                          <SelectItem value={`${targetDraft}|${sandboxClassDraft}`}>{targetDraft} · {sandboxClassDraft} (saved)</SelectItem> : null}
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
                  <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span>App name</span>
                    <Input value={appNameDraft} onChange={(event) => setAppNameDraft(event.target.value)} />
                  </label>
                  <label className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                    <span className="min-w-0">
                      <span className="block text-foreground">Modal VM runtime</span>
                      Modal's default gVisor runtime cannot run a Docker daemon. The full-VM runtime is Modal's recommended way to run Docker in a sandbox.
                    </span>
                    <Switch
                      checked={vmRuntimeDraft}
                      aria-label="Modal VM runtime"
                      onCheckedChange={(value) => { dirty.current = true; setVmRuntimeDraft(value); }}
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
                  <div className="grid gap-2 @md:grid-cols-3">
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

          <div className="grid gap-3 rounded-md bg-muted/35 p-3 text-xs @md:grid-cols-2">
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

      </>

      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      </fieldset>
    </section>
  );
}

function SandboxImageCard() {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [view, setView] = useState<ImageSettingsView | null>(null);
  const [repository, setRepository] = useState("");
  const [platform, setPlatform] = useState("linux/amd64");
  const [packages, setPackages] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [dockerfile, setDockerfile] = useState("");
  const [saving, setSaving] = useState(false);
  const [jobId, setJobId] = useState<string | null>(() => window.sessionStorage.getItem("sandboxes:image-build"));
  const [building, setBuilding] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dirty = useRef(false), request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await rpc.call("imageSettings", null);
      if (id !== request.current || dirty.current) return;
      setView(next); setRepository(next.repository); setPlatform(next.platform || "linux/amd64"); setPackages(next.extraPackages); setSelected(next.recipe.tools); setDockerfile(next.recipe.dockerfile ?? ""); setError("");
    } catch (failure) { if (id === request.current) setError(errorText(failure)); }
  }, [rpc]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  useRealtime("sandbox-provider-settings", useCallback(() => { void load(); }, [load]));
  useRealtime("sandbox-image-builds", useCallback(payload => {
    if (isImageBuildProgress(payload)) setMessage(payload.message);
  }, []));
  const edit = (change: () => void) => { dirty.current = true; change(); };
  const save = async () => {
    if (!view) return;
    setSaving(true); setError(""); request.current++;
    try {
      const next = await rpc.call("updateImageConfiguration", { repository, platform, packages, recipe: { revision: view.recipe.revision, tools: selected as ImageRecipe["tools"], dockerfile } });
      setView(next); setSelected(next.recipe.tools); setPackages(next.extraPackages); dirty.current = false; setMessage("Image settings saved.");
    } catch (failure) { setError(errorText(failure)); }
    finally { setSaving(false); }
  };
  useEffect(() => {
    if (!jobId) return;
    let active = true, cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    setBuilding(true);
    const observe = async () => {
      try {
        const status = await rpc.call("imageBuildStatus", { id: jobId, cursor });
        if (!active) return;
        cursor = status.cursor;
        if (status.progress.length) setMessage(status.progress.at(-1) ?? "Building…");
        if (status.state === "running") { timer = setTimeout(() => void observe(), 2000); return; }
        window.sessionStorage.removeItem("sandboxes:image-build"); setJobId(null); setBuilding(false);
        if (status.state === "error") setError(status.error ?? "Image build failed");
        else { setMessage(`Built image ${status.pinnedReference ?? ""}`); if (status.registrationErrors.length) setError(status.registrationErrors.join("; ")); await load(); }
      } catch (failure) {
        if (!active) return;
        setBuilding(false); setError(`${errorText(failure)}. Check the existing build before starting another.`);
        // Keep the job ID. Reopening observes it; it never starts a replacement.
      }
    };
    void observe();
    return () => { active = false; clearTimeout(timer); };
  }, [rpc, jobId, load]);
  const build = async () => {
    setBuilding(true); setError(""); setMessage("Preparing image build…");
    try { const job = await rpc.call("startImageBuild", {}); window.sessionStorage.setItem("sandboxes:image-build", job.id); setJobId(job.id); }
    catch (failure) { setError(errorText(failure)); setBuilding(false); }
  };
  const groups = [...new Set(imageTools.map(tool => tool.category))];
  return <section className="@container min-w-0 space-y-4">
    {!view ? <p role={error ? "alert" : "status"} className="text-sm">{error || "Loading image settings…"}</p> : <>
      <p className="text-xs text-muted-foreground">Builds run with Docker on this BB server and push to your image registry. No GitHub repository is needed.</p>
      <fieldset disabled={saving || building} className="min-w-0 space-y-4">
        <label className="block min-w-0 space-y-1 text-sm"><span>Image registry repository</span><Input aria-label="Image registry repository" value={repository} placeholder="ghcr.io/your-account/bb-sandbox" onChange={event => edit(() => setRepository(event.target.value))} /><span className="block text-xs text-muted-foreground">Where the built image is stored. Add its credentials in Configuration.</span></label>
        <label className="block min-w-0 space-y-1 text-sm"><span>Platform</span><Select value={platform} onValueChange={value => edit(() => setPlatform(value))}><SelectTrigger aria-label="Image platform"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="linux/amd64">Linux · x86-64</SelectItem><SelectItem value="linux/arm64">Linux · ARM64</SelectItem></SelectContent></Select></label>
        <div className="space-y-2"><h3 className="text-sm font-medium">Image contents</h3><p className="text-xs text-muted-foreground">Required: Node.js, BB host, Git, SSH, the trusted browser and desktop, and connection helpers.</p><p className="text-xs text-muted-foreground">Choose the optional tools below. Existing machines keep their installed tools until replaced.</p></div>
        <details className="min-w-0 space-y-3"><summary className="cursor-pointer text-sm">Included tools</summary><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => edit(() => setSelected([...defaultImageTools]))}>General defaults</Button><Button size="sm" variant="outline" onClick={() => edit(() => setSelected([]))}>Required only</Button></div>
        <Input aria-label="Find image tools" placeholder="Find tools…" value={filter} onChange={event => setFilter(event.target.value)} />
        {groups.filter(category => imageTools.some(tool => tool.category === category && `${tool.label} ${tool.category}`.toLowerCase().includes(filter.toLowerCase()))).map(category => <div key={category} className="min-w-0 space-y-2"><h4 className="text-xs font-medium text-muted-foreground">{category}</h4><div className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 @sm:grid-cols-2">{imageTools.filter(tool => !["fx-acp", "prime-agent-acp"].includes(tool.id) && tool.category === category && `${tool.label} ${tool.category}`.toLowerCase().includes(filter.toLowerCase())).map(tool => {
          const neededBy = imageTools.filter(other => !["fx-acp", "prime-agent-acp"].includes(other.id) && selected.includes(other.id) && (other.requires as readonly string[]).includes(tool.id));
          const canBeRequired = imageTools.some(other => (other.requires as readonly string[]).includes(tool.id));
          return <label key={tool.id} className="flex min-w-0 items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-current" aria-label={tool.label} checked={selected.includes(tool.id)} disabled={neededBy.length > 0} onChange={event => edit(() => { const next = new Set(selected); if (event.target.checked) { next.add(tool.id); for (const dependency of tool.requires) next.add(dependency); } else next.delete(tool.id); const adapter = tool.id === "fx" ? "fx-acp" : tool.id === "prime-agent" ? "prime-agent-acp" : null; if (adapter) { if (event.target.checked) next.add(adapter); else next.delete(adapter); } setSelected([...next]); })} /><span className="min-w-0 break-words">{tool.label}{canBeRequired && <span className={`ml-1 inline-block whitespace-nowrap text-[11px] text-muted-foreground ${neededBy.length === 0 ? "invisible" : ""}`} title={neededBy.length > 0 ? `Required by ${neededBy.map(other => other.label).join(", ")}` : undefined} aria-label={neededBy.length > 0 ? `Required by ${neededBy.map(other => other.label).join(", ")}` : undefined} aria-hidden={neededBy.length === 0} tabIndex={neededBy.length > 0 ? 0 : undefined}>(required)</span>}</span></label>;
        })}</div></div>)}
        </details>
        <label className="block min-w-0 space-y-2 text-sm"><span>Custom Dockerfile instructions</span><textarea aria-label="Custom Dockerfile instructions" spellCheck={false} className="min-h-48 w-full min-w-0 resize-y rounded-md border border-border bg-background p-3 font-mono text-xs" value={dockerfile} placeholder={'# Runs after the BB runtime and included tools\nRUN npm install -g your-tool@1.0.0'} onChange={event => edit(() => setDockerfile(event.target.value))} /><span className="block text-xs text-muted-foreground">Extend the Debian + Node 22 image with RUN, ENV and other supported instructions. Choose tool versions here. Runs only when you build; never put credentials here.</span></label>
        <ImagePackageTags label="Additional Debian packages" values={packages} onChange={next => edit(() => setPackages(next))} max={100} length={100} />
        <div className="flex justify-end"><Button variant="outline" size="sm" disabled={!dirty.current} onClick={() => void save()}>{saving ? "Saving…" : "Save image settings"}</Button></div>
      </fieldset>
      <div className="space-y-2 border-t border-border pt-4"><Button disabled={saving || building || jobId !== null || dirty.current || !view.repository || !view.providers.some(entry => entry.credentialsConfigured)} onClick={() => void build()}>{building ? "Building…" : "Build and register image"}</Button><p className="text-xs text-muted-foreground">Builds use server resources and may incur registry and provider costs. New machines use the new image; running machines stay unchanged.</p>{dirty.current && <p className="text-xs text-muted-foreground">Save your changes before building.</p>}{!view.repository && <p className="text-xs text-muted-foreground">Set an image registry repository first.</p>}</div>
      <div className="space-y-2">{view.providers.map(entry => <div key={entry.provider} className="flex min-w-0 items-start justify-between gap-3 text-xs"><span className="shrink-0 font-medium">{providerLabel(entry.provider)}</span><span className="min-w-0 truncate text-muted-foreground">{entry.activeName ?? (entry.credentialsConfigured ? "No image yet" : "Add provider credentials")}</span></div>)}</div>
      {message && <p role="status" className="break-words text-xs text-muted-foreground">{message}</p>}{error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      {jobId && !building && <Button size="sm" variant="outline" onClick={() => { window.sessionStorage.removeItem("sandboxes:image-build"); setJobId(null); setMessage(""); }}>Dismiss build status</Button>}
    </>}
  </section>;
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
          disabled={updating}
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
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [views, setViews] = useState<ProviderSettingsView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => { void rpc.call("providerSettings", null).then(result => setViews(result.providers), failure => setError(errorText(failure))); }, [rpc]);
  useEffect(load, [load]);
  useRealtime("sandbox-provider-settings", load);
  return <section className="min-w-0 space-y-3" aria-label="Providers">
    <h2 className="text-sm font-medium">Providers</h2>
    <div className="rounded-lg border border-border bg-surface-recessed/70 px-3 divide-y divide-border">
      {sandboxProviderValues.map(provider => {
        const view = views.find(item => item.provider === provider);
        return <div key={provider} className="flex min-w-0 flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1"><div className="text-sm font-medium">{providerLabel(provider)}</div><p className="text-xs text-muted-foreground">{!view ? "Loading…" : !view.credentialsConfigured ? "Add credentials in Configuration" : view.credentialCheck === "invalid" ? "Connection failed — check credentials" : view.credentialCheck !== "valid" ? "Check connection to configure" : view.enabled ? "Enabled" : "Disabled"}</p></div>
          <Switch checked={view?.enabled ?? false} disabled={!view || busy || (!view.enabled && view.credentialCheck !== "valid")} aria-label={`Enable ${providerLabel(provider)}`} onCheckedChange={async enabled => { setBusy(true); setError(""); try { const next = await rpc.call("setProviderEnabled", { provider, enabled }); setViews(previous => previous.map(item => item.provider === provider ? next : item)); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }} />
          {view?.credentialsConfigured && view.credentialCheck !== "valid" && <Button size="sm" variant="outline" aria-label={`Check ${providerLabel(provider)} connection`} disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const next = await rpc.call("checkProviderCredentials", { provider }); setViews(previous => previous.map(item => item.provider === provider ? next : item)); } catch { setError("Could not check provider credentials. Try again."); } finally { setBusy(false); } }}>Check connection</Button>}
          <SettingsDialog disabled={!view || busy || view.credentialCheck !== "valid"} title={providerLabel(provider)} description={providerLifecycleNote(provider)} buttonLabel={`${providerLabel(provider)} options`} icon><ProviderSettingsCard provider={provider} /></SettingsDialog>
        </div>;
      })}
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
function RuntimeSettings() {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [ready, setReady] = useState<boolean | null>(null);
  const load = useCallback(() => { void rpc.call("imageSettings", null).then(view => setReady(view.providers.some(provider => provider.activeName !== null)), () => setReady(null)); }, [rpc]);
  useEffect(load, [load]);
  useRealtime("sandbox-provider-settings", load);
  return <section className="min-w-0 space-y-3"><h2 className="text-sm font-medium">Runtime images</h2>
    <div className="rounded-lg border border-border bg-surface-recessed/70 px-3 divide-y divide-border">
      <div className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm">Image builder</p><p className="text-xs text-muted-foreground">{ready === false ? "No image yet. Choose tools and build your first image." : "Choose tools and build images for new machines."}</p></div><SettingsDialog title="Image builder" description="Choose the contents of new sandbox machines." buttonLabel={ready === false ? "Build first image" : "Configure"}><SandboxImageCard /></SettingsDialog></div>
      <div className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm">Updates</p><p className="text-xs text-muted-foreground">Review runtime versions before upgrading.</p></div><SettingsDialog title="Runtime updates" description="Review the affected images and machines before starting an update." buttonLabel="Review updates"><SandboxUpgradesCard /></SettingsDialog></div>
    </div>
  </section>;
}
function MoreSettings() {
  return <section className="min-w-0 space-y-3"><h2 className="text-sm font-medium">More</h2><div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-recessed/70 px-3 py-3"><div><p className="text-sm">Setup guide</p><p className="text-xs text-muted-foreground">Setup and usage.</p></div><SettingsDialog title="Sandboxes setup guide" description="From your first image to your first cloud thread." buttonLabel="Open setup guide"><ol className="space-y-4 text-sm list-decimal pl-5">
    <li><strong>Connect a provider.</strong> Add its API credentials in Configuration. Open its options in Providers and choose a region or runtime if needed.</li>
    <li><strong>Prepare the builder.</strong> Install Docker with Buildx on this BB server. Create a private container registry repository, such as GHCR or Docker Hub, and add its username and write token in Configuration.</li>
    <li><strong>Build your first image.</strong> Open Runtime images → Image builder. Enter the registry repository, choose its platform and optional tools, and save. Goldsky and HubSpot are optional. Choose Build and register image to build, push, and register the image with your configured Daytona, Modal or E2B providers. This can take a while and may incur costs.</li>
    <li><strong>Choose defaults.</strong> Set the default machine size and idle timeout in Preferences. Modal runs for up to 24 hours and does not sleep on idle.</li>
    <li><strong>Start a thread.</strong> Pick your project and a Sandboxes machine in BB’s new-thread composer. BB creates and retires the machine. New machines use your registered image.</li>
  </ol><p className="mt-4 text-xs text-muted-foreground">Box and Freestyle bootstrap tools at launch and do not use this custom-image builder. Tailscale keys are needed for trusted browser home egress and optional local-editor SSH. Existing machines and images are not changed by saving builder settings.</p></SettingsDialog></div></section>;
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



function SandboxAttachments({ threadId, live }: { threadId: string; live: boolean }) {
  const rpc = useRpc<typeof sandboxRpcContract>();
  const [view, setView] = useState<AttachmentsView | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setView(await rpc.call("threadAttachments", { threadId })); setError(""); }
    catch (failure) { setError(errorText(failure)); }
  }, [rpc, threadId]);
  useEffect(() => { if (live) void load(); }, [live, load]);
  useRealtime("sandboxes", useCallback(() => { if (live) void load(); }, [live, load]));
  const labels = (ids: string[], options: Array<{ id: string; name: string }>) =>
    ids.length ? ids.map(id => options.find(option => option.id === id)?.name ?? id).join(", ") : "None";
  return <section className="min-w-0 space-y-2 border-t border-border pt-3">
    <h3 className="text-xs font-medium">Existing machine context</h3>
    {view ? <dl className="space-y-2 text-xs">
      <div><dt className="text-muted-foreground">Credential set</dt><dd className="break-words">{view.credentialProfileId === null ? "None" : view.credentials.find(item => item.id === view.credentialProfileId)?.name ?? view.credentialProfileId}</dd></div>
      <div><dt className="text-muted-foreground">Project tools</dt><dd className="break-words">{labels(view.toolIds, view.tools)}</dd></div>
      <div><dt className="text-muted-foreground">Skills</dt><dd className="break-words">{labels(view.skillIds, view.skills)}</dd></div>
      <div><dt className="text-muted-foreground">Agents</dt><dd className="break-words">{labels(view.agentIds, view.agents)}</dd></div>
    </dl> : <p role={error ? "alert" : "status"} className="break-words text-xs text-muted-foreground">{error || "Loading existing context…"}</p>}
    <p className="text-xs text-muted-foreground">Legacy machine selections are read-only during migration. Existing scope is retained. Use the source plugin’s project settings for new runs; do not recreate a machine to change a legacy selection.</p>
  </section>;
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
    const machineLabel = view?.managed === false ? "Local machine" : error ? "Machine status unavailable" : "Loading machine status";
    return <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) reloadRoute(); }}>
      <PopoverTrigger asChild>
        <button type="button" className={HEADER_BUTTON_CLASS}
          aria-label={view?.managed === false && summary ? `Local machine. ${summary}. Open model and machine details` : machineLabel}
          title={summary ? `${machineLabel} · ${summary}` : machineLabel}>
          <Icon name="Laptop" className="size-4" />
          {route === null ? null : <FallbackDot route={route} />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-full space-y-3 md:w-[20rem]" mobileTitle="Machine">
        {route === null ? null : <ModelRouteSection route={route} separated={false} />}
        <div className={`flex items-center gap-1.5 text-[11px] text-muted-foreground${route === null ? "" : " border-t border-border pt-3"}`}>
          <Icon name="Laptop" className="size-3.5" />{machineLabel}
        </div>
        {error ? <p role="alert" className="break-words text-xs text-destructive">{error}</p> : null}
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
        <SandboxPreparationStatus threadId={threadId} />
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
  for (const [id, component] of [
    ["preferences", SandboxPreferencesSettings], ["providers", ProviderSettings],
    ["runtime-images", RuntimeSettings], ["oh-my-bb", SandboxIntegrationSettings], ["more", MoreSettings],
  ] as const) app.slots.settingsSection({ id, component });
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
