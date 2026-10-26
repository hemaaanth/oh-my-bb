import { describe, expect, it } from "vitest";
import {
  hostThreadStatus,
  legacyProviderOf,
  nativeProviderOf,
  resolveHostThreadStatuses,
  type HostStatusInput,
} from "./host-status";

const host = (over: Partial<HostStatusInput>): HostStatusInput => ({
  id: "host_1",
  name: "Host 1",
  status: "connected",
  machineProviderId: "sandbox-daytona",
  lifecycle: { phase: "active", teardown: null },
  ...over,
});

describe("nativeProviderOf", () => {
  it("recognizes known sandbox vendors from the machine provider id", () => {
    expect(nativeProviderOf("sandbox-daytona")).toBe("daytona");
    expect(nativeProviderOf("sandbox-nirvana")).toBe("nirvana");
  });

  it("ignores non-sandbox providers, unknown vendors, and null", () => {
    expect(nativeProviderOf(null)).toBeNull();
    expect(nativeProviderOf("fly-machine")).toBeNull();
    expect(nativeProviderOf("sandbox-unknownvendor")).toBeNull();
  });
});

describe("hostThreadStatus", () => {
  it("treats removal and failed teardown as unrecoverable", () => {
    expect(hostThreadStatus(host({ lifecycle: { phase: "destroyed", teardown: null } }))).toBe("unrecoverable");
    expect(hostThreadStatus(host({ lifecycle: { phase: "removing", teardown: null } }))).toBe("unrecoverable");
    expect(
      hostThreadStatus(host({ lifecycle: { phase: "active", teardown: { status: "failed" } } })),
    ).toBe("unrecoverable");
  });

  it("maps suspension to idle and connection to live", () => {
    expect(hostThreadStatus(host({ lifecycle: { phase: "suspended", teardown: null } }))).toBe("idle");
    expect(hostThreadStatus(host({ lifecycle: { phase: "suspending", teardown: null } }))).toBe("idle");
    expect(hostThreadStatus(host({ status: "connected", lifecycle: { phase: "active", teardown: null } }))).toBe("live");
  });

  it("reads coming-up phases as idle and everything else as unreachable", () => {
    expect(hostThreadStatus(host({ status: "disconnected", lifecycle: { phase: "resuming", teardown: null } }))).toBe("idle");
    expect(hostThreadStatus(host({ status: "disconnected", lifecycle: { phase: "creating", teardown: null } }))).toBe("idle");
    expect(hostThreadStatus(host({ status: "disconnected", lifecycle: { phase: "active", teardown: null } }))).toBe("unreachable");
  });
});

describe("resolveHostThreadStatuses", () => {
  it("emits one row per thread on a recognized sandbox host and skips the rest", () => {
    const hosts = [
      host({ id: "host_daytona", name: "Daytona · bb", machineProviderId: "sandbox-daytona", status: "connected", lifecycle: { phase: "active", teardown: null } }),
      host({ id: "host_local", machineProviderId: null }),
      host({ id: "host_other", machineProviderId: "fly-machine" }),
    ];
    const statuses = resolveHostThreadStatuses(
      [
        { threadId: "thr_live", hostId: "host_daytona" },
        { threadId: "thr_local", hostId: "host_local" },
        { threadId: "thr_nonsandbox", hostId: "host_other" },
        { threadId: "thr_unknown", hostId: "host_missing" },
        { threadId: "thr_hostless", hostId: null },
      ],
      hosts,
    );
    expect(statuses).toEqual([
      {
        threadId: "thr_live",
        sandboxId: "host_daytona",
        provider: "daytona",
        status: "live",
        label: "Daytona · bb",
      },
    ]);
  });
});

describe("legacy sandbox hosts", () => {
  it("recognizes manual hosts named after a sandbox vendor", () => {
    expect(legacyProviderOf(host({ name: "Daytona · cdp_dbt", machineProviderId: "manual" }))).toBe("daytona");
    expect(legacyProviderOf(host({ name: "hemarchy", machineProviderId: "manual" }))).toBeNull();
    expect(legacyProviderOf(host({ name: "Daytona · bb", machineProviderId: "fly-machine" }))).toBeNull();
  });

  it("paints a connected legacy host live and a stopped one asleep", () => {
    const hosts = [
      host({ id: "host_awake", name: "Daytona · cdp_dbt", machineProviderId: "manual", status: "connected" }),
      host({ id: "host_asleep", name: "Daytona · site", machineProviderId: null, status: "disconnected" }),
    ];
    const statuses = resolveHostThreadStatuses(
      [
        { threadId: "thr_awake", hostId: "host_awake" },
        { threadId: "thr_asleep", hostId: "host_asleep" },
      ],
      hosts,
    );
    expect(statuses.map(({ threadId, provider, status }) => ({ threadId, provider, status }))).toEqual([
      { threadId: "thr_awake", provider: "daytona", status: "live" },
      { threadId: "thr_asleep", provider: "daytona", status: "idle" },
    ]);
  });
});
