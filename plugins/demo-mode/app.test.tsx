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


test("the native plugin catalog is not covered", async () => {
  vi.stubGlobal("location", { pathname: "/plugins/demo-mode" });
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  setEnabled(MODE_KEY, true);
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

test("workflow titles and queued previews mask while counts remain visible", async () => {
  document.body.innerHTML = `<section aria-label="Workflow"><button id="thread-workflow-card-toggle" aria-label="Workflow: Private launch"><span title="Private launch">Private launch</span><span>1/3 agents</span></button><div id="thread-workflow-card-body"><span class="font-medium">Research</span><span>2/3</span><span title="Review account">Review account</span></div></section><section aria-label="Queued messages"><header>Queue <span>1</span></header><li data-queued-message-row><div title="Send confidential update"><span>Send confidential update</span><code>secret</code></div><span data-queued-message-wait>Held on host private-machine</span></li></section>`;
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  setEnabled(MODE_KEY, true);
  expect(words()).toEqual(["Private", "launch", "Research", "Review", "account", "Send", "confidential", "update", "secret", "Held", "on", "host", "private-machine"]);
  expect(words()).not.toContain("1/3");
  expect(document.querySelector("#thread-workflow-card-toggle")!.getAttribute("aria-label")).toBe("Demo item");
  expect(document.querySelector("[data-queued-message-row] [title]")!.getAttribute("title")).toBe("Demo item");
  document.querySelector("[data-queued-message-row] [title] span")!.textContent = "Another private draft";
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(words()).toContain("Another");
  setEnabled(MODE_KEY, false);
  expect(document.querySelector("#thread-workflow-card-toggle")!.getAttribute("aria-label")).toBe("Workflow: Private launch");
  expect(document.querySelector("[data-queued-message-row] [title]")!.getAttribute("title")).toBe("Send confidential update");
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

test("focus and status headings remain readable while project and workspace names mask", async () => {
  const heading = (label: string, attrs = "") => `<section aria-label="${label}" ${attrs}><div><button><span>◉</span><span>${label}</span><span>3</span></button></div></section>`;
  document.body.innerHTML = `<div data-sidebar="content" data-bb-plugin="status-sidebar"><div role="tabpanel">${["Attention", "Current work", "Libraries", "News", "Archived"].map((label) => heading(label)).join("")}${heading("Private project", 'data-reorder-project-id="p"')}${heading("Private workspace section")}</div></div>`;
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  setEnabled(MODE_KEY, true);
  expect(words()).toEqual(["Private", "project", "Private", "workspace", "section"]);
  expect(document.querySelector('section[aria-label="Attention"]')).not.toBeNull();
  setEnabled(MODE_KEY, false);
  expect(document.querySelector('section[aria-label="Private workspace section"]')).not.toBeNull();
  expect(document.querySelector('[data-bb-demo-identifier]')).toBeNull();
  await scripts.lifecycle.dispose();
  document.body.innerHTML = "";
});

test("label-only markers hide private hover text without masking status, counts, or icons", async () => {
  document.body.innerHTML = `<button data-bb-demo-label title="Private contact" aria-label="Open Ada"><svg aria-hidden="true"><path d="M0 0h1" /></svg><span>In progress</span><b>3</b></button><textarea data-bb-demo-sensitive aria-label="Draft">Private draft</textarea>`;
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  setEnabled(MODE_KEY, true);
  expect(document.querySelector("button")!.getAttribute("title")).toBe("Demo item");
  expect(document.querySelector("button")!.getAttribute("aria-label")).toBe("Demo item");
  expect(words()).not.toContain("In");
  expect(words()).not.toContain("progress");
  expect(words()).not.toContain("3");
  expect(document.querySelector("svg path")).not.toBeNull();
  setEnabled(MODE_KEY, false);
  expect(document.querySelector("button")!.getAttribute("title")).toBe("Private contact");
  await scripts.lifecycle.dispose();
  document.body.innerHTML = "";
});

test("native Info values and row names mask while structure, status, times and counts stay visible", async () => {
  const row = (label: string, value: string) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const section = (label: string, name: string, extra: string) => `<section data-info-section><h3><button>${label}<span>5</span></button></h3><ul><li><span role="img" aria-label="Completed"><svg></svg></span><span class="flex-1"><button title="${name}">${name}</button><span dir="rtl">${name}/</span><button aria-label="Open file in tab"><svg></svg></button></span><span>${extra}</span></li></ul></section>`;
  document.body.innerHTML = `<aside><div data-bb-plugin="core"><dl><div><div>${row("Parent", "None")}${row("Project", '<span title="Secret project">Secret project</span>')}${row("Environment", "Project checkout")}${row("Machine", "Private machine")}${row("Directory", '<button aria-label="Copy directory" title="/private/path">~/private/path</button>')}${row("Branch", "secret-branch")}${row("Git status", "Even with main")}</div></div><div data-bb-plugin="automations">${section("Automations", "Private reminder", "Completed")}</div>${section("Child threads", "Private child", "5m ago")}${section("Uncommitted files", "secret.ts", "+3 -2")}${section("Thread storage", "private-plan.md", "12 KB")}<section data-info-section><h3>Thread storage</h3><li><span class="flex-1"><button aria-expanded="false">Attachments</button></span></li></section><div data-bb-plugin="journal"><section data-info-section><h3>Summary</h3><li><span class="flex-1">Original goal</span><span data-bb-demo-sensitive>Private content</span></li></section></div></dl></div></aside>`;
  const app = await loadPluginApp(() => import("./app"));
  const scripts = await mountPluginContentScripts(app, { pluginId: "demo-mode", generation: 1 });
  setEnabled(MODE_KEY, true);
  for (const word of ["Secret", "project", "Private", "machine", "~/private/path", "secret-branch", "reminder", "child", "secret.ts", "private-plan.md"]) expect(words()).toContain(word);
  for (const word of ["Parent", "None", "Project", "Environment", "checkout", "Machine", "Directory", "Branch", "Git", "status", "Even", "with", "main", "Automations", "Child", "threads", "Uncommitted", "files", "Thread", "storage", "Completed", "5m", "ago", "+3", "-2", "12", "KB", "Attachments", "Original", "goal"]) expect(words()).not.toContain(word);
  expect(screenTitle("/private/path")).toBeNull();
  expect(document.querySelector('[aria-label="Copy directory"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Completed"] svg')).not.toBeNull();
  const project = [...document.querySelectorAll("dt")].find(e => e.textContent === "Project")!.nextElementSibling!;
  project.innerHTML = '<span title="New private project">New private project</span>';
  const detail = (label: string) => [...document.querySelectorAll("dt")].find(e => e.textContent === label)!.nextElementSibling!;
  detail("Parent").textContent = "Private parent";
  detail("Environment").textContent = "Client staging";
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(words()).toContain("New");
  expect(words()).toContain("parent");
  expect(words()).toContain("Client");
  detail("Parent").textContent = "None";
  detail("Environment").textContent = "Project checkout";
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(detail("Parent").hasAttribute("data-bb-demo-native")).toBe(false);
  expect(detail("Environment").hasAttribute("data-bb-demo-native")).toBe(false);
  setEnabled(MODE_KEY, false);
  expect(document.querySelector("[data-bb-demo-native]")).toBeNull();
  expect(screenTitle("New private project")).not.toBeNull();
  await scripts.lifecycle.dispose();
  document.body.innerHTML = "";
});
function screenTitle(title: string) { return [...document.querySelectorAll("[title]")].find(e => e.getAttribute("title") === title) ?? null; }
