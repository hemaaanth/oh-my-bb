// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CHANGED_CHANNEL as CONTRACT_CHANNEL } from "./contract.js";
import { PROJECT, THREAD, createEndpoint, postSigned, sendConfig, webhooksHost, type Host } from "./server/test-fakes.js";

// Node's experimental global localStorage shadows jsdom's and is unusable without a file.
const stored: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
    removeItem: (key: string) => {
      delete stored[key];
    },
    clear: () => {
      for (const key of Object.keys(stored)) delete stored[key];
    },
  },
});

// BB's shared Select, menu, dialog, and checkbox read the viewport, scroll options into view, and watch their size.
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
});
Element.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const app = await loadPluginApp(() => import("./app.js"));
// These import the SDK app runtime, which loadPluginApp installs.
const { CHANGED_CHANNEL, PANEL_PATH } = await import("./app/data.js");
const panel = app.navPanels.find(({ id }) => id === "webhooks")!;

const METHODS = [
  "webhooks_overview",
  "webhooks_get",
  "webhooks_create",
  "webhooks_update",
  "webhooks_set_enabled",
  "webhooks_delete",
  "webhooks_rotate_secret",
  "webhooks_deliveries",
  "webhooks_test",
  "webhooks_targets",
] as const;

let host: Host;
beforeEach(async () => {
  host = await webhooksHost();
});
afterEach(async () => {
  cleanup();
  await host.harness.lifecycle.dispose();
  vi.unstubAllGlobals();
});

/** The panel, wired to the real server RPC handlers in the fake host. */
function renderPanel(subPath = "") {
  const rpc = Object.fromEntries(METHODS.map((method) => [method, (input: unknown) => host.harness.behavior.callRpc(method, input)]));
  return renderSlot(panel, { subPath }, { rpc: rpc as never });
}

const lastNavigation = (slot: ReturnType<typeof renderPanel>) => slot.inspection.navigateCalls.at(-1);

/** Opens a BB select or menu trigger. Their options render in a portal, so they are found on the screen. */
const open = (trigger: HTMLElement) => fireEvent.keyDown(trigger, { key: "Enter" });
async function choose(trigger: HTMLElement, option: string) {
  open(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Webhooks panel", () => {
  it("registers one nav panel and keeps the app's copies of contract values in step", () => {
    expect(panel).toMatchObject({ title: "Webhooks", icon: "webhooks/webhook", path: "webhooks" });
    expect(PANEL_PATH).toBe(panel.path);
    expect(CHANGED_CHANNEL).toBe(CONTRACT_CHANNEL);
  });

  it("lists nothing yet, warns about the missing public URL, and opens the form", async () => {
    const slot = renderPanel();
    await slot.findByText("No endpoints yet.");
    expect(slot.getByText(/so senders can reach this machine/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "New endpoint" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "webhooks", options: { subPath: "new" } });
  });

  it("creates a send endpoint, shows the secret once, and copies it", async () => {
    const slot = renderPanel("new");
    const form = await slot.findByRole("form", { name: "New endpoint" });
    fireEvent.change(slot.getAllByLabelText("Name")[0]!, { target: { value: "Signups" } });
    fireEvent.click(slot.getByRole("button", { name: "Add field" }));
    fireEvent.change(slot.getByLabelText("Field 1 name"), { target: { value: "event" } });
    fireEvent.change(slot.getByLabelText("Field 1 path"), { target: { value: "event.event" } });
    fireEvent.change(slot.getByLabelText("Thread id"), { target: { value: THREAD } });
    fireEvent.change(slot.getByLabelText("Message"), { target: { value: "New {{event}}." } });
    fireEvent.submit(form);

    const reveal = await slot.findByRole("region", { name: "Signing secret" });
    const secret = reveal.querySelector("code")!.textContent!;
    expect(secret).toMatch(/^whsec_/);
    fireEvent.click(slot.getByRole("button", { name: "Copy" }));
    await slot.findByText("Copied.");
    expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: secret }]);

    const { endpoints } = (await host.harness.behavior.callRpc("webhooks_overview", null)) as { endpoints: Array<{ id: string; name: string; fields: unknown[] }> };
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({ name: "Signups", fields: [{ name: "event", path: "event.event", type: "string" }] });
    // The secret the panel showed is the one the route accepts.
    expect((await postSigned(host, endpoints[0]!.id, secret, { event: { event: "signup" } })).status).toBe(200);
    expect(host.sent[0]!.text).toContain('New "signup".');

    fireEvent.click(slot.getByRole("button", { name: "Done" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "webhooks", options: { subPath: endpoints[0]!.id } });
  });

  it("shows the server's reason when a target is refused", async () => {
    host.archived.add("thr_old");
    const slot = renderPanel("new");
    const form = await slot.findByRole("form", { name: "New endpoint" });
    fireEvent.change(slot.getAllByLabelText("Name")[0]!, { target: { value: "Old" } });
    fireEvent.change(slot.getByLabelText("Thread id"), { target: { value: "thr_old" } });
    fireEvent.submit(form);
    await slot.findByText(/archived/);
    expect(((await host.harness.behavior.callRpc("webhooks_overview", null)) as { endpoints: unknown[] }).endpoints).toHaveLength(0);
  });

  it("picks an automation from the project and says the payload is not forwarded", async () => {
    const slot = renderPanel("new");
    const form = await slot.findByRole("form", { name: "New endpoint" });
    fireEvent.change(slot.getAllByLabelText("Name")[0]!, { target: { value: "Triage" } });
    await choose(slot.getByLabelText("Do"), "Run an automation");
    expect(slot.getByText(/Payload fields are not passed in/)).toBeTruthy();
    await choose(await slot.findByLabelText("Project"), "Test Project");
    const automation = await slot.findByLabelText("Automation");
    open(automation);
    // Only the usable automation is offered.
    await waitFor(() => expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Daily triage"]));
    fireEvent.click(screen.getByRole("option", { name: "Daily triage" }));
    fireEvent.submit(form);
    await slot.findByRole("region", { name: "Signing secret" });
    const { endpoints } = (await host.harness.behavior.callRpc("webhooks_overview", null)) as { endpoints: Array<{ action: unknown }> };
    expect(endpoints[0]!.action).toEqual({ type: "automation", projectId: PROJECT, automationId: "auto_daily" });
  });

  it("hands the fields to a receiver plugin picked from the published list", async () => {
    const slot = renderPanel("new");
    const form = await slot.findByRole("form", { name: "New endpoint" });
    fireEvent.change(slot.getAllByLabelText("Name")[0]!, { target: { value: "Calls" } });
    await choose(slot.getByLabelText("Do"), "Hand to a plugin");
    expect(slot.getByText(/No message is sent/)).toBeTruthy();
    expect(slot.queryByLabelText("Message")).toBeNull();
    await choose(await slot.findByLabelText("Plugin"), "Receiver");
    fireEvent.submit(form);
    await slot.findByRole("region", { name: "Signing secret" });
    const { endpoints } = (await host.harness.behavior.callRpc("webhooks_overview", null)) as { endpoints: Array<{ action: unknown }> };
    expect(endpoints[0]!.action).toEqual({ type: "plugin", pluginId: "receiver" });
  });

  it("shows an endpoint's URL and deliveries, and opens the thread a delivery reached", async () => {
    const { endpoint, secret } = await createEndpoint(host, sendConfig({ action: { type: "spawn", projectId: PROJECT, message: "{{event}}" } }));
    await postSigned(host, endpoint.id, secret!, { event: { event: "signup" }, person: { properties: { email: "ada@example.com" } } });
    const slot = renderPanel(endpoint.id);
    await slot.findByText(`https://<your-public-origin>/api/v1/plugins/webhooks/http/deliver?endpoint=${endpoint.id}`);
    expect(slot.getByText(/to get the real origin/)).toBeTruthy();
    expect(slot.queryByText(/ada@example\.com/)).toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Open thread" }));
    expect(lastNavigation(slot)).toMatchObject({ method: "toThread", threadId: "thr_spawned_1" });
  });

  it("sends a test delivery and refreshes on the realtime signal", async () => {
    const { endpoint } = await createEndpoint(host);
    const slot = renderPanel(endpoint.id);
    const payload = await slot.findByLabelText("Payload");
    // The sample payload nests each declared path.
    expect(JSON.parse((payload as HTMLTextAreaElement).value)).toEqual({ event: { event: "" }, person: { properties: { email: "" } } });
    fireEvent.change(payload, { target: { value: JSON.stringify({ event: { event: "from panel" } }) } });
    fireEvent.click(slot.getByRole("button", { name: "Send test" }));
    await slot.findByText(/HTTP 200/);
    expect(host.sent).toHaveLength(1);
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { endpointId: endpoint.id });
    await slot.findByText("Succeeded");
  });

  it("rotates a secret and deletes only after confirmation", async () => {
    const { endpoint } = await createEndpoint(host);
    const slot = renderPanel(endpoint.id);
    const menu = await slot.findByRole("button", { name: "PostHog alerts actions" });
    open(menu);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rotate secret" }));
    await slot.findByRole("region", { name: "Signing secret" });
    open(menu);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(((await host.harness.behavior.callRpc("webhooks_overview", null)) as { endpoints: unknown[] }).endpoints).toHaveLength(1);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "webhooks", options: { subPath: "" } }));
    expect(((await host.harness.behavior.callRpc("webhooks_overview", null)) as { endpoints: unknown[] }).endpoints).toHaveLength(0);
  });
});
