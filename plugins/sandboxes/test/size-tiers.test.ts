import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  formatSizeTier,
  parseSandboxSizeTier,
  sizeTierMatching,
  sizeTierPoolViolations,
  sizeTierResources,
  smallestSizeTierCovering,
} from "../src/size-tiers.js";
import { sandboxMigrations, SandboxStore } from "../src/store.js";

const GIB = 1024 ** 3;

describe("size tiers", () => {
  it("names tiers loosely and describes them exactly", () => {
    expect(parseSandboxSizeTier("l")).toBe("L");
    expect(parseSandboxSizeTier("Extra Large")).toBe("XL");
    expect(parseSandboxSizeTier("huge")).toBeNull();
    expect(formatSizeTier("L")).toBe("L · 8 cores · 16 GiB memory · 40 GiB disk");
    expect(sizeTierResources("M")).toEqual({
      cpuCores: 4,
      memoryBytes: 12 * GIB,
      diskBytes: 20 * GIB,
    });
  });

  it("maps raw numbers back onto tiers", () => {
    expect(sizeTierMatching({ cpuCores: 4, memoryBytes: 12 * GIB, diskBytes: 20 * GIB })).toBe("M");
    expect(sizeTierMatching({ cpuCores: 4, memoryBytes: 12 * GIB, diskBytes: 30 * GIB })).toBeNull();
    // A 30 GiB disk needs L; the tier is the smallest that covers every dimension.
    expect(smallestSizeTierCovering({ diskBytes: 30 * GIB })).toBe("L");
    expect(smallestSizeTierCovering({ cpuCores: 2 })).toBe("S");
    expect(smallestSizeTierCovering({ memoryBytes: 64 * GIB })).toBeNull();
  });

  it("checks tiers against a pool's per-sandbox maximums only", () => {
    const pool = { maxCpuPerSandbox: 8, maxMemoryGiBPerSandbox: 20, maxDiskGiBPerSandbox: 40 };
    expect(sizeTierPoolViolations(pool, "L")).toEqual([]);
    expect(sizeTierPoolViolations(pool, "XL")).toEqual([
      "16 cores exceeds the 8-core sandbox maximum",
      "32 GiB memory exceeds the 20 GiB sandbox maximum",
      "100 GiB disk exceeds the 40 GiB sandbox maximum",
    ]);
    expect(sizeTierPoolViolations({ maxCpuPerSandbox: null, maxMemoryGiBPerSandbox: null, maxDiskGiBPerSandbox: null }, "XL")).toEqual([]);
  });
});

describe("tiered image defaults", () => {
  it("keeps one active image per size and treats untiered images as M", async () => {
    const fake = createFakePluginHost({ pluginId: "sandboxes" });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);

    // A snapshot registered before tiers existed: 4/12/20, which is M.
    const legacy = store.beginImageBuild({
      id: "img_legacy",
      provider: "daytona",
      name: "bb-sandbox-legacy",
      extraPackages: [],
    });
    store.finishImageBuild(legacy.id, { regionId: "us-west-3", sandboxClass: "linux-vm" });
    expect(store.getDefaultImage("daytona")?.name).toBe("bb-sandbox-legacy");
    expect(store.getDefaultImage("daytona", "M")?.name).toBe("bb-sandbox-legacy");
    expect(store.getDefaultImage("daytona", "L")).toBeNull();

    const large = store.beginImageBuild({
      id: "img_l",
      provider: "daytona",
      name: "bb-sandbox-v2-l",
      extraPackages: [],
      sizeTier: "L",
      imageVersion: "v2",
    });
    store.finishImageBuild(large.id, { regionId: "us-west-3", sandboxClass: "linux-vm" });
    // Registering L leaves the M default alone.
    expect(store.getDefaultImage("daytona")?.name).toBe("bb-sandbox-legacy");
    expect(store.getDefaultImage("daytona", "L")?.name).toBe("bb-sandbox-v2-l");

    const medium = store.beginImageBuild({
      id: "img_m",
      provider: "daytona",
      name: "bb-sandbox-v2-m",
      extraPackages: [],
      sizeTier: "M",
      imageVersion: "v2",
    });
    store.finishImageBuild(medium.id, { regionId: "us-west-3", sandboxClass: "linux-vm" });
    // A tiered M retires the untiered image in its region, and region lookups
    // only see images registered into that region.
    expect(store.getDefaultImage("daytona")?.name).toBe("bb-sandbox-v2-m");
    expect(store.requireImage(legacy.id).isDefault).toBe(false);
    expect(store.getDefaultImage("daytona", "M", "us-west-2")).toBeNull();
    expect(store.getDefaultImage("daytona", "M", "us-west-3")?.name).toBe("bb-sandbox-v2-m");

    // The same size in another region is a separate active image.
    const mediumWest2 = store.beginImageBuild({
      id: "img_m_west2",
      provider: "daytona",
      name: "bb-sandbox-v2-m-us-west-2",
      extraPackages: [],
      sizeTier: "M",
      imageVersion: "v2",
    });
    store.finishImageBuild(mediumWest2.id, { regionId: "us-west-2", sandboxClass: "linux-vm" });
    expect(store.getDefaultImage("daytona", "M", "us-west-3")?.name).toBe("bb-sandbox-v2-m");
    expect(store.getDefaultImage("daytona", "M", "us-west-2")?.name).toBe("bb-sandbox-v2-m-us-west-2");
    expect(store.listDefaultImages("daytona").map((image) => image.name).sort()).toEqual([
      "bb-sandbox-v2-l",
      "bb-sandbox-v2-m",
      "bb-sandbox-v2-m-us-west-2",
    ]);

    // Size-agnostic providers keep a single default regardless of tier.
    const modal = store.beginImageBuild({
      id: "img_modal",
      provider: "modal",
      name: "bb-sandbox:v2",
      extraPackages: [],
    });
    store.finishImageBuild(modal.id);
    expect(store.getDefaultImage("modal", "XL")).toBeNull();
    expect(store.getDefaultImage("modal")?.name).toBe("bb-sandbox:v2");
    await fake.harness.dispose();
  });
});
