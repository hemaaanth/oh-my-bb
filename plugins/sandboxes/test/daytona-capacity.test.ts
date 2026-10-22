import { describe, expect, it, vi } from "vitest";
import {
  discoverDaytonaCapacity,
  selectedDaytonaPool,
  validateDaytonaResources,
} from "../src/daytona-capacity.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

describe("Daytona capacity", () => {
  it("discovers the organization, regions, and class-specific quota pools", async () => {
    const fetcher = vi.fn((url: string) => {
      if (url.includes("/sandbox?")) {
        return Promise.resolve(
          jsonResponse({ items: [{ organizationId: "org-1" }] }),
        );
      }
      if (url.endsWith("/regions")) {
        return Promise.resolve(
          jsonResponse([
            { id: "us-west-3", name: "US West 3", regionType: "shared" },
          ]),
        );
      }
      if (url.endsWith("/organizations/org-1/usage")) {
        return Promise.resolve(
          jsonResponse({
            regionUsage: [
              {
                regionId: "us-west-3",
                sandboxClass: "linux-vm",
                totalCpuQuota: 160,
                currentCpuUsage: 16,
                totalMemoryQuota: 320,
                currentMemoryUsage: 32,
                totalDiskQuota: 1000,
                currentDiskUsage: 100,
                maxCpuPerSandbox: 16,
                maxMemoryPerSandbox: 32,
                maxDiskPerSandbox: 100,
                maxSandboxLifespan: null,
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const capacity = await discoverDaytonaCapacity({
      apiKey: "secret",
      fetcher: fetcher as typeof fetch,
    });

    expect(capacity.organizationId).toBe("org-1");
    expect(capacity.pools).toEqual([
      {
        regionId: "us-west-3",
        regionName: "US West 3",
        regionType: "shared",
        sandboxClass: "linux-vm",
        totalCpu: 160,
        usedCpu: 16,
        totalMemoryGiB: 320,
        usedMemoryGiB: 32,
        totalDiskGiB: 1000,
        usedDiskGiB: 100,
        maxCpuPerSandbox: 16,
        maxMemoryGiBPerSandbox: 32,
        maxDiskGiBPerSandbox: 100,
        maxLifespanMinutes: null,
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("falls back to snapshot ownership when no sandbox exists", async () => {
    const fetcher = vi.fn((url: string) => {
      if (url.includes("/sandbox?")) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      if (url.includes("/snapshots?")) {
        return Promise.resolve(
          jsonResponse({ items: [{ organizationId: "org-from-snapshot" }] }),
        );
      }
      if (url.endsWith("/regions")) return Promise.resolve(jsonResponse([]));
      if (url.endsWith("/organizations/org-from-snapshot/usage")) {
        return Promise.resolve(jsonResponse({ regionUsage: [] }));
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await expect(
      discoverDaytonaCapacity({
        apiKey: "secret",
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toMatchObject({ organizationId: "org-from-snapshot" });
  });

  it("selects one placement pool and rejects profiles above its maximums", () => {
    const pool = {
      regionId: "us-west-3",
      regionName: "US West 3",
      regionType: "shared",
      sandboxClass: "linux-vm" as const,
      totalCpu: 160,
      usedCpu: 0,
      totalMemoryGiB: 320,
      usedMemoryGiB: 0,
      totalDiskGiB: 1000,
      usedDiskGiB: 0,
      maxCpuPerSandbox: 16,
      maxMemoryGiBPerSandbox: 32,
      maxDiskGiBPerSandbox: 100,
      maxLifespanMinutes: null,
    };
    const capacity = {
      organizationId: "org-1",
      refreshedAt: 1,
      pools: [pool],
    };
    expect(
      selectedDaytonaPool(capacity, {
        regionId: "us-west-3",
        sandboxClass: "linux-vm",
      }),
    ).toBe(pool);
    expect(() =>
      validateDaytonaResources(pool, {
        cpuCores: 17,
        memoryBytes: 33 * 1024 ** 3,
        diskBytes: 101 * 1024 ** 3,
      }),
    ).toThrow(
      "CPU 17 exceeds the 16-core sandbox maximum; memory 33 GiB exceeds the 32 GiB sandbox maximum; disk 101 GiB exceeds the 100 GiB sandbox maximum",
    );
  });
});
