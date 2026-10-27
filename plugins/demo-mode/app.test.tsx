// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import { CHANGE, enabled, HIGHLIGHT, MODE_KEY, setEnabled } from "./state";

const highlights = new Map<string, Set<StaticRange>>();
const words = () => [...highlights.get(HIGHLIGHT) ?? []].map((range) => (range.startContainer as Text).data.slice(range.startOffset, range.endOffset));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  // jsdom has no CSS highlight registry.
  vi.stubGlobal("Highlight", class extends Set {});
  vi.stubGlobal("CSS", { highlights });
  highlights.clear();
  localStorage.clear();
  document.body.removeAttribute("data-bb-demo-mode");
  document.body.removeAttribute("data-bb-demo-plugin-page");
});
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

test("footer action toggles masks and disposal restores the page", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  expect(document.body.hasAttribute("data-bb-demo-mode")).toBe(false);
  expect(app.experimentalSidebarFooterItems).toHaveLength(1);
  const action = app.experimentalSidebarFooterItems[0]!;
  if (action.kind !== "action") throw new Error("Expected footer action");
  action.onActivate({ openPluginDetails() {} });
  expect(localStorage.getItem(MODE_KEY)).toBe("true");
  expect(document.body.hasAttribute("data-bb-demo-mode")).toBe(true);
  action.onActivate({ openPluginDetails() {} });
  expect(document.body.hasAttribute("data-bb-demo-mode")).toBe(false);
  setEnabled(MODE_KEY, true);
  await scripts.lifecycle.dispose();
  expect(document.body.hasAttribute("data-bb-demo-mode")).toBe(false);
  window.dispatchEvent(new Event(CHANGE));
  expect(document.body.hasAttribute("data-bb-demo-mode")).toBe(false);
});

test("plugin pages are masked whenever Demo Mode is on", async () => {
  vi.stubGlobal("location", { pathname: "/plugins/journal/journal" });
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  expect(document.body.hasAttribute("data-bb-demo-plugin-page")).toBe(false);
  setEnabled(MODE_KEY, true);
  expect(document.body.hasAttribute("data-bb-demo-plugin-page")).toBe(true);
  setEnabled(MODE_KEY, false);
  expect(document.body.hasAttribute("data-bb-demo-plugin-page")).toBe(false);
  await scripts.lifecycle.dispose();
});


test("sidebar labels are concealed and restored without touching indicators", async () => {
  document.body.innerHTML = `<div data-sidebar="content"><a data-sidebar-thread-id="t" aria-label="Private thread"><span class="bb-thread-title" title="Private thread">Private thread</span><span data-status>●</span></a></div>`;
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  setEnabled(MODE_KEY, true);
  const link = document.querySelector("a")!;
  expect(link.getAttribute("aria-label")).toBe("Demo item");
  expect(link.querySelector(".bb-thread-title")!.getAttribute("title")).toBe("Demo item");
  expect(link.querySelector("[data-status]")!.textContent).toBe("●");
  setEnabled(MODE_KEY, false);
  expect(link.getAttribute("aria-label")).toBe("Private thread");
  expect(link.querySelector(".bb-thread-title")!.getAttribute("title")).toBe("Private thread");
  await scripts.lifecycle.dispose();
  document.body.innerHTML = "";
});


test("every masked word becomes one block and blocks follow draft edits", async () => {
  document.body.innerHTML = `<div data-sidebar="content"><span class="bb-thread-title" title="Boost cold outbound">Boost cold outbound</span><span data-project-metadata><span>superspot</span></span></div><div data-message-column><p>Short <b>reply</b></p><img src="x.png"></div><span>Full Access</span><div data-promptbox-shell><div data-promptbox-editor-content><div contenteditable="true"><p>Draft</p></div></div><button aria-label="Thread details: private-branch"><span class="truncate">private-branch</span></button><section aria-label="Thread context before sending"><button id="thread-prompt-banner-git-toggle" aria-label="Changed files: Uncommitted, 765 files">Uncommitted · 765</button></section></div><div class="px-2"><span class="animate-shine">Working</span></div><div class="group/timeline-row"><span title="npm run dev">npm</span></div>`;
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  setEnabled(MODE_KEY, true);
  expect(words()).toEqual(["Boost", "cold", "outbound", "superspot", "Short", "reply", "Draft", "private-branch", "Uncommitted", "·", "765", "Working", "npm"]);
  expect(document.querySelector("[class~='group/timeline-row'] span")!.getAttribute("title")).toBe("Demo item");
  document.querySelector("[contenteditable] p")!.firstChild!.textContent = "Draft two";
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(words()).toContain("two");
  document.querySelector("[data-message-column]")!.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(words()).not.toContain("reply");
  const branch = document.querySelector("[aria-label='Demo item']")!;
  expect(branch.hasAttribute("data-bb-demo-identifier")).toBe(true);
  setEnabled(MODE_KEY, false);
  expect(highlights.has(HIGHLIGHT)).toBe(false);
  expect(branch.getAttribute("aria-label")).toBe("Thread details: private-branch");
  expect(branch.hasAttribute("data-bb-demo-identifier")).toBe(false);
  await scripts.lifecycle.dispose();
  document.body.innerHTML = "";
});

test("plugin pages mask only the parts they mark sensitive", async () => {
  document.body.innerHTML = `<main><div data-bb-demo-ready><h2>Telegram</h2><article><b data-bb-demo-sensitive title="Ben Saltiel">Ben Saltiel</b><p data-bb-demo-sensitive>Ship it</p><button aria-label="Reply">Reply</button></article></div></main>`;
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  setEnabled(MODE_KEY, true);
  expect(words()).toEqual(["Ben", "Saltiel", "Ship", "it"]);
  expect(document.querySelector("b")!.getAttribute("title")).toBe("Demo item");
  expect(document.querySelector("button")!.getAttribute("aria-label")).toBe("Reply");
  document.querySelector("article")!.insertAdjacentHTML("beforeend", `<p data-bb-demo-sensitive>Later</p>`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(words()).toContain("Later");
  await scripts.lifecycle.dispose();
  document.body.innerHTML = "";
});

test("toggle still works in the current window when storage is blocked", () => {
  vi.stubGlobal("localStorage", {
    getItem() { throw new Error("Storage blocked"); },
    setItem() { throw new Error("Storage blocked"); },
    clear() {},
  });
  setEnabled(MODE_KEY, true);
  expect(enabled(MODE_KEY)).toBe(true);
  setEnabled(MODE_KEY, false);
});
