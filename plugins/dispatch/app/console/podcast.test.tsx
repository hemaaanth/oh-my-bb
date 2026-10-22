// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PodcastPanel } from "./podcast.js";
const app = await loadPluginApp(() => import("../index.js"));
const views: Array<{ lifecycle: { unmount(): void } }> = [];
afterEach(() => { views.splice(0).forEach(view => view.lifecycle.unmount()); });
it("loads project people on demand and saves a scoped voice profile", async () => {
  const profile = { projectId: "site", name: "Website", voice: "cedar", enabled: true, personality: "Calm", topics: "layout" };
  const view = renderSlot({ ...app.navPanels[0]!, component: PodcastPanel }, { subPath: "" }, { pluginId: "dispatch", rpc: {
    podcastProfiles: () => ({ profiles: [profile] }), podcastProfileSave: (input: unknown) => input,
  } as never });
  views.push(view);
  expect(view.inspection.rpcCalls).toEqual([]);
  fireEvent.click(view.getByText("Podcast"));
  await view.findByDisplayValue("Calm");
  fireEvent.click(view.getByText("Project people"));
  fireEvent.change(view.getByLabelText("Name for Website"), { target: { value: "Rowan" } });
  fireEvent.click(view.getByRole("button", { name: "Save person" }));
  await view.findByRole("button", { name: "Save person" });
  expect(view.inspection.rpcCalls).toContainEqual(expect.objectContaining({ method: "podcastProfileSave", input: expect.objectContaining({ projectId: "site", name: "Rowan" }) }));
});
