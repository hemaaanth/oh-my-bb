// @vitest-environment jsdom
// Settings pane: the route Edit drawer shows illegal entries as blocked, key
// values are never rendered, the routing and Jev auto switches call the RPC, and
// the thread badge shows the route and Jev's pick.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  AccountPoolConfig,
  AccountSummary,
  PoolStatus,
} from "./src/contracts.js";

// jsdom omits this browser method; Radix uses it when a Select opens.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const app = await loadPluginApp(() => import("./app"));
afterEach(() => { cleanup(); sessionStorage.clear(); });

const CLAUDE_BLOCK = "Claude OAuth accounts serve only the claude-code harness";

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    kind: "oauth",
    label: "max",
    email: "person@example.com",
    accountUuid: null,
    subscriptionType: "Max",
    rateLimitTier: null,
    enabled: true,
    priority: 100,
    createdAt: 1,
    lastUsedAt: null,
    lastUsedHostId: null,
    lastUsedHostName: null,
    fiveHourUtilization: 0.21,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [],
    resetCredits: null,
    observedAt: null,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    ...overrides,
  };
}

function status(accounts: AccountSummary[]): PoolStatus {
  return {
    route: "/api/v1/plugins/model-gateway/http",
    enabledAccountCount: accounts.length,
    inFlight: 0,
    accepting: true,
    hosts: [],
    routedThreadsWithoutLocalLogin: [],
    accounts,
    routing: { claude: false, codex: false },
  };
}

const CONFIG: AccountPoolConfig = {
  anthropicUpstreamBaseUrl: "https://api.anthropic.com",
  codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
  switchThreshold: 0.98,
  chains: {
    "claude-code": ["claude-oauth:*"],
    codex: ["chatgpt-oauth:*"],
    "acp-omp": ["chatgpt-oauth:*"],
    "acp-fx": ["chatgpt-oauth:*"],
    "acp-nanocodex": ["chatgpt-oauth:*"],
    "acp-prime-agent": ["chatgpt-oauth:*"],
    pi: ["chatgpt-oauth:*"],
  },
  modelMap: {},
  auto: { harnesses: [], key: null, model: "typesafe/jev-1.13" },
} as AccountPoolConfig;

const HARNESSES = [
  "claude-code",
  "codex",
  "acp-omp",
  "acp-fx",
  "acp-nanocodex",
  "acp-prime-agent",
  "pi",
] as const;

function chainOptions() {
  return Object.fromEntries(
    HARNESSES.map((harness) => [
      harness,
      [
        {
          entry: "claude-oauth:*",
          label: "Claude Max",
          blocked: harness === "claude-code" ? null : CLAUDE_BLOCK,
        },
        { entry: "chatgpt-oauth:*", label: "ChatGPT", blocked: null },
        {
          entry: "responses-compatible-key:openrouter",
          label: "openrouter",
          blocked: null,
        },
      ],
    ]),
  );
}

function render(extraRpc: Record<string, (input: unknown) => unknown> = {}) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "status.get": () =>
          status([
            account(),
            account({
              id: "22222222-2222-4222-8222-222222222222",
              provider: "codex",
              kind: "api-key",
              label: "openrouter",
              subscriptionType: null,
              baseUrl: "https://openrouter.ai/api/v1",
            }),
          ]),
        "config.get": () => CONFIG,
        "routing.get": () => ({
          enabled: {
            claude: false,
            codex: false,
            "acp-omp": false,
            "acp-fx": false,
            "acp-nanocodex": false,
            "acp-prime-agent": false,
            pi: false,
          },
          blockedBy: null,
          setup: {
            "acp-omp": "bb gateway setup omp",
            "acp-fx": "fx login codex",
            "acp-nanocodex": "nanocodex setup",
            "acp-prime-agent": "bb gateway setup prime-agent",
            pi: "bb gateway setup pi",
          },
          ladders: Object.fromEntries(
            HARNESSES.map((harness) => [
              harness,
              harness === "claude-code"
                ? ["claude-sonnet-5", "claude-opus-5-5"]
                : ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"],
            ]),
          ),
        }),
        "chain.options": chainOptions,
        "live.get": () => ({ threads: [], holds: [] }),
        ...extraRpc,
      } as never,
      openUrl: () => true,
    },
  );
}

async function openRoute(slot: ReturnType<typeof render>, harness: string) {
  fireEvent.click(
    await slot.findByRole("button", { name: `Edit ${harness} route` }),
  );
}

describe("Model Gateway settings", () => {
  it("shows Claude Max as blocked in the Codex Edit drawer and cannot add it", async () => {
    const slot = render({ "chain.set": () => CONFIG });
    await openRoute(slot, "Codex");
    const add = await slot.findByRole("combobox", {
      name: "Add to the Codex route",
    });
    fireEvent.click(add);
    const blocked = await slot.findByRole("option", {
      name: new RegExp(`Claude Max.*${CLAUDE_BLOCK}`),
    });
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(blocked);
    fireEvent.click(await slot.findByRole("option", { name: /openrouter/i }));
    await waitFor(() =>
      expect(
        slot.rpcCalls.filter((call) => call.method === "chain.set"),
      ).toEqual([
        {
          method: "chain.set",
          input: {
            harness: "codex",
            entries: ["chatgpt-oauth:*", "responses-compatible-key:openrouter"],
          },
        },
      ]),
    );
  });

  it("shows a blocked entry already in a route with its reason", async () => {
    const slot = render({
      "config.get": () => ({
        ...CONFIG,
        chains: { ...CONFIG.chains, codex: ["claude-oauth:*", "chatgpt-oauth:*"] },
      }),
    });
    await openRoute(slot, "Codex");
    await slot.findByRole("button", { name: "Remove Claude Max from Codex" });
    expect(slot.getAllByText(CLAUDE_BLOCK).length).toBeGreaterThan(0);
    expect(slot.getAllByText("Blocked").length).toBeGreaterThan(0);
  });

  it("sends a new API key to key.add and never renders its value", async () => {
    const secret = "sk-test-NEVER-RENDERED";
    const slot = render({ "key.add": () => account() });
    fireEvent.keyDown(await slot.findByRole("button", { name: "Add" }), {
      key: "Enter",
    });
    fireEvent.click(
      await slot.findByRole("menuitem", { name: /Add API key/ }),
    );
    fireEvent.change(await slot.findByLabelText("Key label"), {
      target: { value: "anthropic" },
    });
    const keyInput = slot.getByLabelText("API key") as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    fireEvent.change(keyInput, { target: { value: secret } });
    expect(document.body.textContent).not.toContain(secret);
    fireEvent.click(slot.getByRole("button", { name: "Add API key" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "key.add",
        input: {
          kind: "claude-key",
          label: "anthropic",
          apiKey: secret,
          priority: 100,
        },
      }),
    );
    expect(document.body.textContent).not.toContain(secret);
    expect(document.body.innerHTML).not.toContain(secret);
  });

  it("returns focus to Add after canceling a menu-opened key form", async () => {
    const slot = render();
    const add = await slot.findByRole("button", { name: "Add" });
    add.focus();
    fireEvent.keyDown(add, { key: "Enter" });
    fireEvent.click(await slot.findByRole("menuitem", { name: /Add API key/ }));
    await slot.findByRole("dialog", { name: "Add an API key" });
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it("routes a harness through routing.set", async () => {
    const slot = render({ "routing.set": () => ({ ok: true }) });
    const toggle = await slot.findByRole("switch", {
      name: "Route Pi threads",
    });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "routing.set",
        input: { provider: "pi", enabled: true },
      }),
    );
  });
  it("uses friendly API-key names without changing route identifiers", async () => {
    const entry = "responses-compatible-key:monthly-api-credits";
    const key = account({
      id: "22222222-2222-4222-8222-222222222222", provider: "codex", kind: "api-key",
      label: "monthly-api-credits", email: null,
    });
    const slot = render({
      "status.get": () => status([account(), key]),
      "chain.options": () => ({
        ...chainOptions(),
        pi: [
          { entry: "chatgpt-oauth:*", label: "ChatGPT", blocked: null },
          { entry, label: key.label, blocked: null },
        ],
      }),
      "config.get": () => ({ ...CONFIG, chains: { ...CONFIG.chains, pi: ["chatgpt-oauth:*", entry] } }),
      "chain.set": () => CONFIG,
    });
    await openRoute(slot, "Pi");
    fireEvent.click(await slot.findByRole("button", { name: "Remove Monthly API credits from Pi" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({
      method: "chain.set", input: { harness: "pi", entries: ["chatgpt-oauth:*"] },
    }));
  });

  it("keeps API-key details factual instead of rendering subscription quota controls", async () => {
    const key = account({ kind: "api-key", label: "monthly-api-credits", email: null, observedAt: 10 });
    const slot = render({ "status.get": () => status([key]) });
    fireEvent.click(await slot.findByRole("button", { name: "Open Monthly API credits" }));
    await slot.findByRole("dialog", { name: "Monthly API credits" });
    expect(slot.queryByRole("button", { name: "Refresh usage" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Technical details" }));
    expect(slot.getByText(key.label)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Disable" })).toBeTruthy();
  });


  it("turns Jev auto on for one harness from its Edit drawer", async () => {
    const withKey = { ...CONFIG, auto: { ...CONFIG.auto, key: "openrouter" } };
    const slot = render({
      "config.get": () => withKey,
      "auto.set": () => ({
        ...withKey,
        auto: { ...withKey.auto, harnesses: ["claude-code"] },
      }),
    });
    await openRoute(slot, "Claude Code");
    const toggle = await slot.findByRole("switch", {
      name: "Auto (Jev) for Claude Code",
    });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "auto.set",
        input: { harness: "claude-code", off: false },
      }),
    );
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("keeps the saved Jev key when discovery has not returned that account", async () => {
    let discovered = false;
    const slot = render({
      "config.get": () => ({ ...CONFIG, auto: { ...CONFIG.auto, key: "saved-router" } }),
      "status.get": () => status(discovered ? [account({
        provider: "codex", kind: "api-key", label: "saved-router",
      })] : []),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
    const picker = await slot.findByRole("combobox", { name: "Jev key" });
    expect(picker.hasAttribute("disabled")).toBe(true);
    discovered = true;
    await slot.emitRealtime("model-gateway.accounts-changed", {});
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    fireEvent.click(picker);
    expect(slot.getByRole("option", { name: "Saved router" }).getAttribute("data-state")).toBe("checked");
    expect(slot.rpcCalls.filter((call) => call.method === "auto.set")).toEqual([]);
  });

  it("disables Jev auto with the reason when no responses-compatible key exists", async () => {
    const slot = render({ "status.get": () => status([account()]) });
    await openRoute(slot, "Pi");
    const toggle = await slot.findByRole("switch", { name: "Auto (Jev) for Pi" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
  });
});

describe("Model Gateway thread header", () => {
  it("leaves the route to the Sandboxes machine popover", () => {
    expect(app.threadHeaderActions).toHaveLength(0);
  });
});

describe("Gateway composer fallback", () => {
  it("shows only during fallback and updates without changing the selected model", async () => {
    let route: { model: string; chainIndex: number; chain: string[]; accountLabel: string } | null = null;
    const action = app.composerCustomizations.find((item) => item.id === "gateway-fallback")!.actions![0]!;
    const slot = renderSlot(action, {}, {
      composer: { scope: { kind: "thread", threadId: "thr_fallback" } },
      rpc: { "thread.route": () => route },
    });
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.queryByRole("status")).toBeNull();
    route = { model: "gpt-6-sol", chainIndex: 1, chain: ["Claude Max", "ChatGPT"], accountLabel: "fallback account" };
    await slot.emitRealtime("model-gateway.route-changed", { threadId: "thr_fallback" });
    expect((await slot.findByRole("status")).textContent).toBe("6-Sol");
    expect(slot.getByRole("status").title).toContain("fallback account");
    expect(slot.getByRole("status").getAttribute("aria-label")).toBe("Fallback: 6-Sol");
    expect(slot.getByRole("status").querySelector("svg")).not.toBeNull();
    expect(slot.getByRole("status").className).toContain("bg-warning/5");
    expect(slot.composer.selections).toHaveLength(0);
    await slot.setComposerScope({ kind: "thread", threadId: "thr_other" });
    route = null;
    await slot.emitRealtime("model-gateway.route-changed", { threadId: "thr_other" });
    await waitFor(() => expect(slot.queryByRole("status")).toBeNull());
    await slot.setComposerScope({ kind: "thread", threadId: "thr_fallback" });
    route = { model: "gpt-6-sol", chainIndex: 1, chain: ["Claude Max", "ChatGPT"], accountLabel: "fallback account" };
    await slot.emitRealtime("model-gateway.route-changed", { threadId: "thr_fallback" });
    await slot.findByRole("status");
    route = { ...route, chainIndex: 0 };
    await slot.emitRealtime("model-gateway.route-changed", { threadId: "thr_fallback" });
    await waitFor(() => expect(slot.queryByRole("status")).toBeNull());
  });

});

describe("Model usage footer", () => {
  it("keeps API-key accounts out of subscription usage, including cached accounts", async () => {
    const footer = app.experimentalSidebarFooterItems.find((item) => item.id === "gateway-usage");
    if (footer?.kind !== "disclosure") throw new Error("Missing Gateway usage disclosure");
    const key = account({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "api-key", label: "monthly-api-credits", email: null,
    });
    const rpc = { "account.list": () => [account(), key] } as never;
    const first = renderSlot(footer, { dismiss: () => {} }, { rpc });
    await first.findByRole("progressbar", { name: "max 5h usage" });
    expect(first.queryByText(key.label)).toBeNull();
    first.unmount();
    const cached = renderSlot(footer, { dismiss: () => {} }, { rpc });
    expect(cached.getByRole("progressbar", { name: "max 5h usage" }).getAttribute("aria-valuenow")).toBe("21");
    expect(cached.queryByText(key.label)).toBeNull();
  });

  it("shows one row per provider account across duplicate logins", async () => {
    const footer = app.experimentalSidebarFooterItems.find((item) => item.id === "gateway-usage");
    expect(footer?.kind).toBe("disclosure");
    if (footer?.kind !== "disclosure") return;
    const first = account({ accountUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const duplicate = account({
      id: "33333333-3333-4333-8333-333333333333",
      accountUuid: first.accountUuid,
      label: "same Claude login",
    });
    const slot = renderSlot(footer, { dismiss: () => {} }, { rpc: {
      "account.list": () => [first, duplicate],
    } as never });
    await slot.findByText("person@example.com");
    expect(slot.getAllByText("person@example.com")).toHaveLength(1);
    expect(slot.getByRole("progressbar", { name: "max 5h usage" }).getAttribute("aria-valuenow")).toBe("21");
    expect(slot.queryByText("same Claude login")).toBeNull();
  });

  it("omits empty Codex secondary windows", async () => {
    const footer = app.experimentalSidebarFooterItems.find((item) => item.id === "gateway-usage");
    if (footer?.kind !== "disclosure") throw new Error("Missing Gateway usage disclosure");
    const codex = account({
      provider: "codex", label: "pro", subscriptionType: "pro", fiveHourUtilization: null,
      limitWindows: [
        { slot: "primary", windowMinutes: 10_080, utilization: 0.76, resetAt: null, status: null, observedAt: 1, source: "usage" },
        { slot: "secondary", windowMinutes: null, utilization: 0, resetAt: 0, status: null, observedAt: 1, source: "header" },
      ],
    });
    const slot = renderSlot(footer, { dismiss: () => {} }, { rpc: {
      "account.list": () => [codex],
    } as never });
    await slot.findByText("person@example.com");
    expect(slot.getAllByRole("progressbar")).toHaveLength(1);
    expect(slot.getByRole("progressbar", { name: "pro 7d usage" }).getAttribute("aria-valuenow")).toBe("76");
  });

  it("renders accounts cached before reset credits existed", async () => {
    const footer = app.experimentalSidebarFooterItems.find((item) => item.id === "gateway-usage");
    if (footer?.kind !== "disclosure") throw new Error("Missing Gateway usage disclosure");
    const { resetCredits: _, ...legacy } = account({ provider: "codex", label: "pro" });
    const slot = renderSlot(footer, { dismiss: () => {} }, { rpc: {
      "account.list": () => [legacy],
    } as never });
    await slot.findByText("person@example.com");
  });

  it("shows Codex one-off reset credits", async () => {
    const footer = app.experimentalSidebarFooterItems.find((item) => item.id === "gateway-usage");
    if (footer?.kind !== "disclosure") throw new Error("Missing Gateway usage disclosure");
    const slot = renderSlot(footer, { dismiss: () => {} }, { rpc: {
      "account.list": () => [
        account({ provider: "codex", label: "pro", resetCredits: { available: 3, usable: 0 } }),
        account({ id: "22222222-2222-4222-8222-222222222222", provider: "codex", label: "lite",
          email: "other@example.com", resetCredits: { available: 1, usable: 1 } }),
      ],
    } as never });
    await slot.findByText("3 resets available");
    expect(slot.getByText("1 reset available")).toBeTruthy();
  });

  it("shows all accounts and their limits together", async () => {
    const footer = app.experimentalSidebarFooterItems.find((item) => item.id === "gateway-usage");
    if (footer?.kind !== "disclosure") throw new Error("Missing Gateway usage disclosure");
    const codex = account({
      id: "22222222-2222-4222-8222-222222222222", provider: "codex", label: "pro", email: "other@example.com",
      fiveHourUtilization: null, limitWindows: [
        { slot: "primary", windowMinutes: 10_080, utilization: 0.76, resetAt: null, status: null, observedAt: 1, source: "usage" },
      ],
    });
    const slot = renderSlot(footer, { dismiss: () => {} }, { rpc: {
      "account.list": () => [account(), codex],
    } as never });
    await slot.findByText("other@example.com");
    expect(slot.getByText("person@example.com")).toBeTruthy();
    expect(slot.getByRole("progressbar", { name: "pro 7d usage" }).getAttribute("aria-valuenow")).toBe("76");
    expect(slot.getAllByRole("progressbar")).toHaveLength(2);
    expect(slot.getByRole("button", { name: "Refresh Gateway usage" }).querySelector('[data-icon="RotateCcw"]')).toBeTruthy();
    expect(slot.container.querySelector(".overflow-y-auto")).toBeNull();
  });

  it("opens instantly from cached usage and refreshes only on demand", async () => {
    const footer = app.experimentalSidebarFooterItems.find((item) => item.id === "gateway-usage");
    if (footer?.kind !== "disclosure") throw new Error("Missing Gateway usage disclosure");
    let lists = 0;
    let refreshes = 0;
    const rpc = {
      "account.list": () => { lists++; return [account()]; },
      "account.refreshUsage": () => { refreshes++; return account(); },
    } as never;
    const first = renderSlot(footer, { dismiss: () => {} }, { rpc });
    await first.findByRole("progressbar");
    expect(lists).toBe(1);
    first.unmount();
    const second = renderSlot(footer, { dismiss: () => {} }, { rpc });
    expect(second.getByRole("progressbar")).toBeTruthy();
    expect(lists).toBe(1);
    fireEvent.click(second.getByRole("button", { name: "Refresh Gateway usage" }));
    await waitFor(() => expect(refreshes).toBe(1));
    await waitFor(() => expect(lists).toBe(2));
  });
});
