// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../shared/constants.js";
import type { CallRow, DeviceProfile, LiveStatus, TraceRow, UsageReport } from "../../shared/contract.js";
import { installFakeLocalStorage, makePrefsRpc } from "../settings/support.js";
import { ConsolePanel, registerStartCall, useConsoleBadge } from "./index.js";
import { memoryLine } from "./calls-list.js";
import { ConsoleStatusOverlay } from "./presence.js";
import { formatCallWhen } from "./format.js";
import { USAGE_NOTE, usageTotals } from "./usage.js";
import { ENDED_STATUS_MS, PHONE_WAIT_MS, phoneAttempt } from "../phone-status.js";
import { IDLE_CALL, callStore } from "../../voice/call-store.js";

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
  forgotten: false,
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
  const view = renderSlot({ ...panel, component: (props) => <><ConsoleStatusOverlay /><ConsolePanel {...props} /></> }, { subPath }, { rpc: rpc as never, pluginId: "dispatch" });
  return { view, calls };
};
const countOf = (calls: Array<{ name: string }>, name: string) => calls.filter((entry) => entry.name === name).length;

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
});
afterEach(() => {
  cleanup();
  phoneAttempt.set(null);
  callStore.set(IDLE_CALL);
  vi.useRealTimers();
});

describe("Calls list", () => {
  it("uses short calendar-relative dates", () => {
    const now = new Date(2026, 9, 19, 12).getTime();
    expect(formatCallWhen(new Date(2026, 9, 19, 10).getTime(), now)).toMatch(/^Today /);
    expect(formatCallWhen(new Date(2026, 9, 18, 10).getTime(), now)).toMatch(/^Yesterday /);
    expect(formatCallWhen(new Date(2026, 9, 1, 10).getTime(), now)).not.toMatch(/Today|Yesterday/);
  });

  it("aligns device, time, duration, cost and quiet status without redundant chips", async () => {
    mount();
    const button = await screen.findByRole("button", { name: /Chrome on Linux/ });
    const row = button.closest("tr")!;
    expect(row.textContent).toContain("1:30");
    expect(row.textContent).toContain("$0.08");
    expect(row.textContent).toContain("Ended");
    expect(row.textContent).not.toContain("1.5 min");
    const table = within(screen.getByRole("region", { name: "Calls" })).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((item) => item.textContent)).toEqual(["When", "Device", "Duration", "Cost", "Status"]);
    expect(button.querySelector("[aria-label='In-app call']")).toBeTruthy();
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

  it("shows an unclean ending as status text and stale open rows as not closed", async () => {
    mount({ callsPage: async () => ({ calls: [call(1, { unclean: true }), call(2, { endedAt: null })], nextCursor: null }) });
    const rows = (await screen.findAllByRole("button", { name: /Chrome on Linux/ })).map((button) => button.closest("tr")!);
    expect(rows[0]!.textContent).toContain("Unclean end");
    expect(rows[1]!.textContent).toContain("Not closed");
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

  it("shows local app connection status before the session is live", async () => {
    callStore.set({ ...IDLE_CALL, state: "connecting", nonce: "pending" });
    mount();
    expect((await screen.findAllByText("Connecting…")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Mute" })).toBeNull();
  });

  it("shows phone waiting, live and ended state without success details", async () => {
    let status: LiveStatus = idle;
    const sid = `CA${"a".repeat(32)}`;
    const { view } = mount({ liveStatus: async () => status, phoneDial: async () => ({ status: "placed", detail: `Calling +15555550123 ${sid}` }) });
    fireEvent.click(await screen.findByRole("button", { name: "Call my phone" }));
    await screen.findByText("Waiting for you to answer…");
    expect((screen.getByRole("button", { name: "Calling…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain(sid);
    expect(document.body.textContent).not.toContain("+15555550123");
    status = { live: true, channel: "phone", startedAt: Date.now() - 65_000, device: { ...device, label: "Phone" } };
    await view.emitRealtime(CHANNELS.traceTail, { callId: "phone-1", events: [trace(101, "call.started", { channel: "phone" })] });
    await screen.findByText("Phone call live");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mute" })).toBeNull();
    expect(phoneAttempt.get()).toBeNull();
    status = idle;
    await view.emitRealtime(CHANNELS.traceTail, { callId: "phone-1", events: [trace(102, "call.stopped")] });
    await screen.findByText("Call ended");
    expect(screen.getByRole("button", { name: "Call my phone" })).toBeTruthy();
  });

  it("ends a short phone session even if it closes before a live-status read", async () => {
    const { view } = mount();
    await screen.findByRole("button", { name: "Call my phone" });
    act(() => phoneAttempt.set({ phase: "ringing", at: Date.now() - 1000 }));
    const at = Date.now();
    await view.emitRealtime(CHANNELS.traceTail, { callId: "short-phone", events: [
      { ...trace(104, "call.started", { channel: "phone" }), at },
      { ...trace(105, "call.closed"), at: at + 10 },
    ] });
    await screen.findByText("Call ended");
    expect(phoneAttempt.get()).toBeNull();
  });

  it("clears phone waiting status when the incoming session fails", async () => {
    const { view } = mount();
    await screen.findByRole("button", { name: "Call my phone" });
    act(() => phoneAttempt.set({ phase: "ringing", at: Date.now() - 1000 }));
    await screen.findByText("Waiting for you to answer…");
    await view.emitRealtime(CHANNELS.traceTail, { callId: "phone-1", events: [{ ...trace(103, "call.failed"), at: Date.now() }] });
    await screen.findByText("Call failed");
    expect(screen.getByRole("button", { name: "Call my phone" })).toBeTruthy();
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
  it("totals today and the last seven calendar days without dropping zero-usage days", () => {
    const report = usage({ perDay: [
      { day: "2026-10-10", seconds: 600, usd: 0.5, calls: 1 },
      { day: "2026-10-13", seconds: 120, usd: 0.1, calls: 1 },
      { day: "2026-10-19", seconds: 60, usd: 0.05, calls: 1 },
    ], totalSeconds: 780, totalUsd: 0.65 });
    const totals = usageTotals(report, new Date(2026, 9, 19, 12).getTime());
    expect(totals.map((total) => total.seconds)).toEqual([60, 180, 780]);
    expect(usageTotals(usage({ perDay: [] }), new Date(2026, 9, 19).getTime())[0]!.seconds).toBe(0);
  });

  it("shows the day rows, a total row and the exact pricing note", async () => {
    mount();
    const section = await screen.findByRole("region", { name: "Usage" });
    const disclosure = (await within(section).findByText("Daily usage & pricing")).closest("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(within(section).getByText("Daily usage & pricing"));
    expect(within(section).getByText("Usage, last 30 days")).toBeTruthy();
    expect(within(section).getByText("2026-10-18")).toBeTruthy();
    expect(within(section).getByText("Total")).toBeTruthy();
    expect(within(section).getByText(USAGE_NOTE)).toBeTruthy();
    expect(USAGE_NOTE).toBe("GPT-Live voice at $0.05 per minute. Reasoning model tokens are billed separately by OpenAI and are not counted here.");
  });
});

describe("Realtime channels", () => {
  it("redacts phone numbers and provider references in recorded errors and system detail", async () => {
    const sid = `CA${"b".repeat(32)}`;
    mount({ callTrace: async () => ({ events: [trace(1, "error", { message: `Could not call +15555550123: ${sid}` }), trace(2, "conn.state", { callSid: sid, number: "+15555550123" })], nextCursor: null }) }, "call-1");
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Show 1 system event" }));
    expect(document.body.textContent).not.toContain(sid);
    expect(document.body.textContent).not.toContain("+15555550123");
    expect(document.body.textContent).toContain("•••0123");
  });

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
    return <p data-testid="badge">{badge ? `${badge.phase}|${badge.text}|${badge.tone ?? "default"}` : "none"}</p>;
  };
  const probe = (liveStatus: () => Promise<LiveStatus> = async () => idle) => {
    const rpc = { liveStatus };
    return renderSlot({ ...panel, component: () => <><ConsoleStatusOverlay /><Probe /></> }, { subPath: "" }, { rpc: rpc as never, pluginId: "dispatch" });
  };

  it("follows a phone attempt and trace-driven live status without app presence", async () => {
    let status: LiveStatus = idle;
    const view = probe(async () => status);
    await screen.findByTestId("badge");
    act(() => phoneAttempt.set({ phase: "dialing", at: Date.now() }));
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("dialing|Calling|default"));
    act(() => phoneAttempt.set({ phase: "ringing", at: Date.now() }));
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("ringing|Calling|default"));
    status = { live: true, channel: "phone", startedAt: Date.now() - 65_000, device };
    await view.emitRealtime(CHANNELS.traceTail, { callId: "phone-1", events: [trace(101, "call.started")] });
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toMatch(/^live\|1:0\d\|default$/));
    status = idle;
    await view.emitRealtime(CHANNELS.traceTail, { callId: "phone-1", events: [trace(102, "call.closed")] });
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("ended|Ended|default"));
  });

  it("bounds waiting status when no phone session is confirmed", async () => {
    vi.useFakeTimers();
    probe();
    await act(async () => {});
    act(() => phoneAttempt.set({ phase: "ringing", at: Date.now() }));
    await act(async () => { await vi.advanceTimersByTimeAsync(PHONE_WAIT_MS + 1000); });
    expect(screen.getByTestId("badge").textContent).toBe("unconfirmed|Not connected|default");
    await act(async () => { await vi.advanceTimersByTimeAsync(ENDED_STATUS_MS + 1000); });
    expect(screen.getByTestId("badge").textContent).toBe("none");
    expect(phoneAttempt.get()).toBeNull();
  });

  it("is empty when idle, then follows the presence channel", async () => {
    const view = probe();
    expect((await screen.findByTestId("badge")).textContent).toBe("none");
    const startedAt = Date.now() - 65_000;
    await view.emitRealtime(CHANNELS.presence, { nonce: "n", phase: "live", startedAt, clientId: "c", realmId: "r" });
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toMatch(/^live\|1:0\d\|default$/));
    await view.emitRealtime(CHANNELS.presence, { nonce: "n", phase: "muted", startedAt, clientId: "c", realmId: "r" });
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toMatch(/^muted\|1:0\d\|warning$/));
    await view.emitRealtime(CHANNELS.presence, { nonce: "n", phase: "idle", startedAt: null, clientId: "c", realmId: "r" });
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("ended|Ended|default"));
  });
});

describe("call memory line", () => {
  const summary = { localDay: "2026-10-19", timeZone: "UTC", title: "Header fix", summary: "Fixed the header.", topics: [], threadIds: [], model: null, createdAt: 0 };
  it("shows the summary title, nothing for a skipped call, and a note for a forgotten one", () => {
    expect(memoryLine(call(1, { summary: { ...summary, status: "done" } }))).toEqual({ line: "Header fix", full: "Fixed the header." });
    expect(memoryLine(call(1, { summary: { ...summary, status: "skipped" } }))).toBeNull();
    expect(memoryLine(call(1))).toBeNull();
    expect(memoryLine(call(1, { forgotten: true }))?.line).toBe("Not remembered");
  });
});
