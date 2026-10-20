// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../shared/constants.js";
import type { CallRow, DeviceProfile, LiveStatus, TraceRow, UsageReport } from "../../shared/contract.js";
import { installFakeLocalStorage, makePrefsRpc } from "../settings/support.js";
import { registerStartCall, useConsoleBadge } from "./index.js";
import { USAGE_NOTE } from "./usage.js";

const stored = installFakeLocalStorage();
const app = await loadPluginApp(() => import("../index.js"));
const panel = app.navPanels.find((entry) => entry.id === "console");
if (!panel) throw new Error("no console nav panel");

const device: DeviceProfile = { platform: "Linux", mobile: false, browser: "Chrome", displayMode: "browser", runtime: "browser", label: "Chrome on Linux" };
const call = (n: number, over: Partial<CallRow> = {}): CallRow => ({
  id: `call-${n}`,
  openaiSessionId: null,
  channel: "app",
  nonce: `nonce-${n}`,
  clientId: "client",
  device,
  threadId: null,
  projectId: null,
  startedAt: Date.UTC(2026, 9, 19, 10, n),
  endedAt: Date.UTC(2026, 9, 19, 10, n, 90),
  closeReason: "user",
  billedSeconds: 90,
  unclean: false,
  ...over,
});
const trace = (id: number, kind: string, payload: Record<string, unknown> | null = null): TraceRow => ({ id, callId: "call-1", at: Date.UTC(2026, 9, 19, 10, 0, id), kind, payload });
const usage = (over: Partial<UsageReport> = {}): UsageReport => ({
  days: 30,
  usdPerMinute: 0.05,
  rateCheckedOn: "2026-10-19",
  perDay: [{ day: "2026-10-18", seconds: 180, usd: 0.15, calls: 2 }],
  totalSeconds: 180,
  totalUsd: 0.15,
  legacyTokenRows: 0,
  ...over,
});
const idle: LiveStatus = { live: false, channel: null, startedAt: null, device: null };

type Fakes = Record<string, (...args: never[]) => unknown>;
type Handlers = Record<string, (input: never) => unknown>;
const mount = (over: Fakes = {}, subPath = "") => {
  const prefs = makePrefsRpc();
  const fakes: Handlers = {
    ...prefs.handlers,
    liveStatus: async () => idle,
    callsPage: async () => ({ calls: [call(1)], nextCursor: null }),
    callTrace: async () => ({ events: [], nextCursor: null }),
    usageReport: async () => usage(),
    ...(over as Handlers),
  };
  const calls: Array<{ name: string; args: unknown }> = [];
  const rpc = new Proxy(fakes, {
    get:
      (target, key: string) =>
      async (args: unknown) => {
        calls.push({ name: key, args });
        return target[key]?.(args as never);
      },
  });
  const view = renderSlot(panel, { subPath }, { rpc: rpc as never, pluginId: "dispatch" });
  return { view, calls };
};
const countOf = (calls: Array<{ name: string }>, name: string) => calls.filter((entry) => entry.name === name).length;

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
});
afterEach(() => {
  cleanup();
});

describe("Calls list", () => {
  it("shows the device, time, duration, channel, billed minutes and cost per row", async () => {
    mount();
    const row = (await screen.findByRole("button", { name: /Chrome on Linux/ })) as HTMLElement;
    expect(row.textContent).toContain("app");
    expect(row.textContent).toContain("1:30");
    expect(row.textContent).toContain("$0.08");
  });

  it("asks for 50 per page and loads the next page on demand", async () => {
    const callsPage = vi.fn(async (args: { cursor?: string }) => (args.cursor ? { calls: [call(2, { device: { ...device, label: "Second page" } })], nextCursor: null } : { calls: [call(1)], nextCursor: "c1" }));
    mount({ callsPage });
    await screen.findByRole("button", { name: /Chrome on Linux/ });
    expect(callsPage).toHaveBeenCalledWith({ limit: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Second page/ });
    expect(callsPage).toHaveBeenLastCalledWith({ cursor: "c1", limit: 50 });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("filters by channel with the chips", async () => {
    mount({ callsPage: async () => ({ calls: [call(1), call(2, { channel: "phone", device: { ...device, label: "Pixel", mobile: true } })], nextCursor: null }) });
    await screen.findByRole("button", { name: /Pixel/ });
    fireEvent.click(screen.getByRole("button", { name: "App" }));
    expect(screen.queryByRole("button", { name: /Pixel/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Chrome on Linux/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Phone" }));
    expect(screen.queryByRole("button", { name: /Chrome on Linux/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Pixel/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("button", { name: /Chrome on Linux|Pixel/ })).toHaveLength(2);
  });

  it("opens a transcript through the route when a row is clicked", async () => {
    const { view } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /Chrome on Linux/ }));
    expect(view.inspection.navigateCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(view.inspection.navigateCalls)).toContain("call-1");
    await screen.findByRole("region", { name: "Transcript" });
  });

  it("opens the transcript named by the route", async () => {
    const callTrace = vi.fn(async () => ({ events: [trace(1, "speech.user", { text: "Hello there" })], nextCursor: null }));
    mount({ callTrace }, "call-1");
    expect(await screen.findByText("Hello there")).toBeTruthy();
    expect(callTrace).toHaveBeenCalledWith({ callId: "call-1" });
  });
});

describe("Transcript", () => {
  const events = [
    trace(1, "call.start"),
    trace(2, "speech.user", { text: "Open the diff" }),
    trace(3, "tool.call", { name: "show_diff", args: { threadId: "t1" }, callId: "x1" }),
    trace(4, "tool.result", { name: "show_diff", callId: "x1", status: "ok", output: "Opened." }),
    trace(5, "speech.agent", { text: "Done, it is open." }),
    trace(6, "tool.call", { name: "stop_thread", args: {}, callId: "x2" }),
    trace(7, "tool.result", { name: "stop_thread", callId: "x2", status: "error", output: "No such thread" }),
    trace(8, "error", { message: "Socket dropped" }),
  ];
  const open = async (over: Fakes = {}) => {
    const rendered = mount({ callTrace: async () => ({ events, nextCursor: null }), ...over }, "call-1");
    await screen.findByText("Open the diff");
    return rendered;
  };

  it("groups tool calls with their results and keeps speech in order", async () => {
    await open();
    const items = screen.getAllByRole("listitem").map((node) => node.textContent ?? "");
    expect(items.some((text) => text.includes("You") && text.includes("Open the diff"))).toBe(true);
    expect(items.some((text) => text.includes("Juno") && text.includes("Done, it is open."))).toBe(true);
    expect(screen.getByRole("button", { name: /details of Showed a diff/i })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Done" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("img", { name: "Failed" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toContain("Socket dropped");
    expect(screen.queryByText("No such thread")).toBeNull();
  });

  it("expands an action to show its arguments and result", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /details of Showed a diff/i }));
    expect(screen.getByText(/"threadId": "t1"/)).toBeTruthy();
    expect(screen.getByText("Opened.")).toBeTruthy();
  });

  it("filters with Talk, Actions and Errors", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Talk" }));
    expect(screen.getByText("Open the diff")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /details of Showed a diff/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByText("Open the diff")).toBeNull();
    expect(screen.getByRole("button", { name: /details of Showed a diff/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Errors" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /details of Showed a diff/i })).toBeNull();
    expect(screen.getByRole("button", { name: /details of Stopped a thread/i })).toBeTruthy();
  });

  it("appends live events from trace-tail without fetching again", async () => {
    const { view, calls } = await open();
    const before = countOf(calls, "callTrace");
    await view.emitRealtime(CHANNELS.traceTail, { callId: "call-1", events: [trace(9, "speech.agent", { text: "Fresh words" })] });
    expect(await screen.findByText("Fresh words")).toBeTruthy();
    await view.emitRealtime(CHANNELS.traceTail, { callId: "call-1", events: [trace(9, "speech.agent", { text: "Fresh words" })] });
    expect(screen.getAllByText("Fresh words")).toHaveLength(1);
    await view.emitRealtime(CHANNELS.traceTail, { callId: "other", events: [trace(10, "speech.agent", { text: "Elsewhere" })] });
    expect(screen.queryByText("Elsewhere")).toBeNull();
    expect(countOf(calls, "callTrace")).toBe(before);
  });

  it("pages older events with Load more", async () => {
    const callTrace = vi.fn(async (args: { cursor?: string }) => (args.cursor ? { events: [trace(20, "speech.user", { text: "Second batch" })], nextCursor: null } : { events: [trace(2, "speech.user", { text: "First batch" })], nextCursor: "n1" }));
    mount({ callTrace }, "call-1");
    await screen.findByText("First batch");
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    await screen.findByText("Second batch");
    expect(callTrace).toHaveBeenLastCalledWith({ callId: "call-1", cursor: "n1" });
  });

  it("closes on Escape, but not while typing in a field", async () => {
    const { view } = await open();
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Transcript" })).not.toBeNull();
    field.remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Transcript" })).toBeNull());
    expect(view.inspection.navigateCalls.length).toBeGreaterThan(0);
    expect(await screen.findByRole("region", { name: "Calls" })).toBeTruthy();
  });

  it("closes with the Back button", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Back to calls" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Transcript" })).toBeNull());
  });
});

describe("Header", () => {
  it("offers Wake and Call my phone when idle, and Wake needs a registered start", async () => {
    mount();
    const wake = (await screen.findByRole("button", { name: "Wake Juno" })) as HTMLButtonElement;
    expect(wake.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Call my phone" })).toBeTruthy();
    const start = vi.fn();
    const unregister = registerStartCall(start);
    await waitFor(() => expect((screen.getByRole("button", { name: "Wake Juno" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Wake Juno" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    unregister();
  });

  const live = { live: true, channel: "app" as const, startedAt: Date.now() - 65_000, device };

  it("shows elapsed time and controls while live, and stop and mute call the server", async () => {
    const relayCommand = vi.fn(async () => ({ delivered: true }));
    const endCallsEverywhere = vi.fn(async () => ({ stopped: 1 }));
    const { view } = mount({ liveStatus: async () => live, relayCommand, endCallsEverywhere });
    await screen.findByRole("button", { name: "Stop" });
    expect(screen.getByText(/^1:0\d$/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Wake Juno" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    await waitFor(() => expect(relayCommand).toHaveBeenCalledWith({ command: "mute" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(endCallsEverywhere).toHaveBeenCalledWith({ reason: "console" }));
    void view;
  });

  it("follows the presence channel for mute state and aims commands at its nonce", async () => {
    const relayCommand = vi.fn(async () => ({ delivered: true }));
    const { view } = mount({ relayCommand });
    await screen.findByRole("button", { name: "Wake Juno" });
    await view.emitRealtime(CHANNELS.presence, { nonce: "n-7", phase: "muted", startedAt: Date.now(), clientId: "c", realmId: "r" });
    fireEvent.click(await screen.findByRole("button", { name: "Unmute" }));
    await waitFor(() => expect(relayCommand).toHaveBeenCalledWith({ command: "unmute", nonce: "n-7" }));
    await view.emitRealtime(CHANNELS.presence, { nonce: "n-7", phase: "idle", startedAt: null, clientId: "c", realmId: "r" });
    await screen.findByRole("button", { name: "Wake Juno" });
  });

  it("opens the live call's transcript from View transcript", async () => {
    const liveCall = call(3, { endedAt: null, billedSeconds: 0, device: { ...device, label: "This laptop" } });
    mount({ liveStatus: async () => live, callsPage: async () => ({ calls: [call(1), liveCall], nextCursor: null }) });
    await screen.findByRole("button", { name: /This laptop/ });
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    await screen.findByRole("region", { name: "Transcript" });
  });

  it("shows a failure from the server instead of throwing", async () => {
    mount({
      liveStatus: async () => live,
      endCallsEverywhere: async () => {
        throw new Error("Server said no");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByText(/Server said no/)).toBeTruthy();
  });
});

describe("Usage", () => {
  it("shows the day rows, a total row and the exact pricing note", async () => {
    mount();
    const section = await screen.findByRole("region", { name: "Usage" });
    expect(within(section).getByText("Usage, last 30 days")).toBeTruthy();
    expect(within(section).getByText("2026-10-18")).toBeTruthy();
    expect(within(section).getByText("Total")).toBeTruthy();
    expect(within(section).getByText(USAGE_NOTE)).toBeTruthy();
    expect(USAGE_NOTE).toBe("GPT-Live voice at $0.05 per minute. Reasoning model tokens are billed separately by OpenAI and are not counted here.");
    expect(within(section).queryByText(/older token-based usage/)).toBeNull();
  });

  it("shows a legacy row only when legacy token rows exist", async () => {
    mount({ usageReport: async () => usage({ legacyTokenRows: 12 }) });
    const section = await screen.findByRole("region", { name: "Usage" });
    expect(within(section).getByText(/older token-based usage/).textContent).toContain("12");
  });
});

describe("Realtime channels", () => {
  it("never renders a payload as markup", async () => {
    const { view } = mount({}, "call-1");
    await screen.findByRole("region", { name: "Transcript" });
    await view.emitRealtime(CHANNELS.traceTail, { callId: "call-1", events: [trace(30, "speech.user", { text: "<img src=x onerror=alert(1)>" })] });
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img[src='x']")).toBeNull();
  });
});

describe("Sidebar badge", () => {
  const Probe = () => {
    const badge = useConsoleBadge();
    return <p data-testid="badge">{badge ? `${badge.text}|${badge.tone ?? "default"}` : "none"}</p>;
  };
  const probe = () => {
    const rpc = { liveStatus: async () => idle };
    return renderSlot({ ...panel, component: Probe }, { subPath: "" }, { rpc: rpc as never, pluginId: "dispatch" });
  };

  it("is empty when idle, then follows the presence channel", async () => {
    const view = probe();
    expect((await screen.findByTestId("badge")).textContent).toBe("none");
    await view.emitRealtime(CHANNELS.presence, { nonce: "n", phase: "live", startedAt: 1, clientId: "c", realmId: "r" });
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("Live|default"));
    await view.emitRealtime(CHANNELS.presence, { nonce: "n", phase: "muted", startedAt: 1, clientId: "c", realmId: "r" });
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("Muted|warning"));
    await view.emitRealtime(CHANNELS.presence, { nonce: "n", phase: "idle", startedAt: null, clientId: "c", realmId: "r" });
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("none"));
  });
});
