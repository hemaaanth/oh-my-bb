import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { sandboxMigrations, SandboxStore } from "../src/store.js";

describe("sandbox provider and image settings", () => {
  it("stores always on separately for each machine", async () => {
    const fake = createFakePluginHost({ pluginId: "sandboxes" });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);
    expect(store.isAlwaysOn("host_1")).toBe(false);
    store.setAlwaysOn("host_1", true);
    expect(new SandboxStore(db).isAlwaysOn("host_1")).toBe(true);
    expect(store.isAlwaysOn("host_2")).toBe(false);
    store.setAlwaysOn("host_1", false);
    expect(store.isAlwaysOn("host_1")).toBe(false);
    await fake.harness.dispose();
  });

  it("keeps provider enablement and immutable image history", async () => {
    const fake = createFakePluginHost({ pluginId: "sandboxes" });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);

    expect(store.getProviderSettings("daytona")).toMatchObject({
      enabled: true,
      extraPackages: [],
    });
    expect(
      store.updateProviderSettings("daytona", {
        enabled: false,
        extraPackages: ["imagemagick"],
      }),
    ).toMatchObject({ enabled: false, extraPackages: ["imagemagick"] });

    const first = store.beginImageBuild({
      id: "img_first",
      provider: "daytona",
      name: "bb-sandbox-first",
      extraPackages: ["imagemagick"],
    });
    store.finishImageBuild(first.id);
    const second = store.beginImageBuild({
      id: "img_second",
      provider: "daytona",
      name: "bb-sandbox-second",
      extraPackages: ["imagemagick"],
    });
    store.finishImageBuild(second.id);

    expect(store.getDefaultImage("daytona")?.name).toBe("bb-sandbox-second");
    expect(store.listImages("daytona")).toMatchObject([
      { name: "bb-sandbox-second", isDefault: true, status: "ready" },
      { name: "bb-sandbox-first", isDefault: false, status: "ready" },
    ]);
    await fake.harness.dispose();
  });

  it("keeps a pinned registry reference as a Modal image name", async () => {
    const fake = createFakePluginHost({ pluginId: "sandboxes" });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);
    const reference = `ghcr.io/acme/bb-sandbox@sha256:${"d".repeat(64)}`;

    const image = store.beginImageBuild({
      id: "img_modal",
      provider: "modal",
      name: reference,
      extraPackages: [],
    });
    store.finishImageBuild(image.id);

    expect(store.getDefaultImage("modal")).toMatchObject({
      name: reference,
      isDefault: true,
      status: "ready",
    });
    await fake.harness.dispose();
  });

  it("marks builds interrupted by a plugin restart as failed", async () => {
    const fake = createFakePluginHost({ pluginId: "sandboxes" });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);

    store.beginImageBuild({
      id: "img_interrupted",
      provider: "e2b",
      name: "bb-sandbox-interrupted",
      extraPackages: [],
    });

    expect(store.failInterruptedImageBuilds()).toBe(1);
    expect(store.requireImage("img_interrupted")).toMatchObject({
      status: "error",
      isDefault: false,
      error: "Image build was interrupted by a plugin restart",
    });
    expect(store.failInterruptedImageBuilds()).toBe(0);
    await fake.harness.dispose();
  });
});
