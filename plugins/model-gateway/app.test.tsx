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
            pi: false,
          },
          blockedBy: null,
          setup: {
            "acp-omp": "bb gateway setup omp",
            "acp-fx": "fx login codex",
            "acp-nanocodex": "nanocodex setup",
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
    fireEvent.click(await slot.findByRole("option", { name: "openrouter" }));
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

  it("shows each route in plain names with its mapped models", async () => {
    const slot = render({
      "config.get": () => ({
        ...CONFIG,
        chains: {
          ...CONFIG.chains,
          "claude-code": ["claude-oauth:*", "chatgpt-oauth:*"],
        },
        modelMap: {
          "chatgpt-oauth": {
            "claude-opus-*": "gpt-6-astra",
            "claude-fable-*": "gpt-6-astra",
            "claude-sonnet-*": "gpt-6-sol",
          },
        },
      }),
    });
    await slot.findByText(
      "On ChatGPT: Opus, Fable → gpt-6-astra · Sonnet → gpt-6-sol",
    );
    expect(document.body.textContent).toContain("Claude Max → ChatGPT");
    expect(document.body.textContent).not.toContain("claude-oauth:*");
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
    expect(slot.getAllByText(/Jev picks Sonnet or Opus/).length).toBeGreaterThan(0);
    expect(slot.getAllByText(/OpenRouter lists only typesafe\/jev-router/).length).toBeGreaterThan(0);
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "auto.set",
        input: { harness: "claude-code", off: false },
      }),
    );
    await slot.findByText(
      "Auto (Jev): Jev picks Sonnet or Opus on each new user turn.",
    );
  });

  it("disables Jev auto with the reason when no responses-compatible key exists", async () => {
    const slot = render({ "status.get": () => status([account()]) });
    await openRoute(slot, "Pi");
    const toggle = await slot.findByRole("switch", { name: "Auto (Jev) for Pi" });
    await slot.findByText(/Add a responses-compatible API key/);
    expect(toggle.hasAttribute("disabled")).toBe(true);
  });
});

describe("Model Gateway thread badge", () => {
  function renderBadge(route: unknown) {
    return renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: "thr_1" } as never,
      { rpc: { "thread.route": () => route } as never },
    );
  }
  const ROUTE = {
    harness: "claude-code",
    upstreamKind: "claude-oauth",
    accountLabel: "max",
    model: "claude-sonnet-5",
    chainIndex: 0,
    chain: ["Claude Max", "ChatGPT"],
    stickyUntil: null,
    autoModel: null,
    auto: null,
  };

  it("shows the primary route quietly, with the chain in its tooltip", async () => {
    const slot = renderBadge(ROUTE);
    const badge = await slot.findByText(/Claude Max · claude-sonnet-5/);
    expect(badge.getAttribute("title")).toContain(
      "Model Gateway route for Claude Code: Claude Max → ChatGPT",
    );
  });

  it("shows Jev's pick when auto changed the model", async () => {
    const slot = renderBadge({
      ...ROUTE,
      model: "claude-opus-5-5",
      autoModel: "claude-opus-5-5",
      auto: "jev 0.82",
    });
    await slot.findByText(/auto → claude-opus-5-5 \(jev 0\.82\)/);
  });
});

describe("Model Gateway usage footer", () => {
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
