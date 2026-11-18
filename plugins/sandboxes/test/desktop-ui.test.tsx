// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));
const card = app.messageDirectives.find((slot) => slot.id === "sandbox-desktop")!;
const props = {
  attributes: {},
  message: { threadId: "thr_desktop" },
  source: "::sandbox-desktop{}",
  openWorkspaceFile: null,
} as never;
const desktop = (url = "https://viewer.example/#grant", viewOnly = true, expires = Date.now() + 60000) =>
  ({ kind: "open", url, expires, viewOnly }) as const;

afterEach(cleanup);

it("offers an external link without a sidebar tab, header action or iframe", async () => {
  const view = desktop();
  const openUrl = vi.fn();
  const slot = renderSlot(card, props, { rpc: { getSandboxDesktop: async () => view } as never, openUrl });
  const link = await slot.findByRole("link", { name: "Open desktop in browser" });
  expect(link.getAttribute("href")).toBe(view.url);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  fireEvent.click(link);
  expect(openUrl).not.toHaveBeenCalled();
  expect(document.querySelector("iframe")).toBeNull();
  expect(app.tabs.some((tab) => tab.id === "desktop")).toBe(false);
  expect(app.threadHeaderActions.some((action) => action.id === "desktop")).toBe(false);
});

it("updates the browser link after switching control and removes it on close", async () => {
  const next = desktop("https://viewer.example/#interactive", false);
  const openSandboxDesktop = vi.fn(async () => next);
  const closeSandboxDesktop = vi.fn(async () => null);
  const slot = renderSlot(card, props, {
    rpc: { getSandboxDesktop: async () => desktop(), openSandboxDesktop, closeSandboxDesktop } as never,
  });
  fireEvent.click(await slot.findByRole("button", { name: "Enable control" }));
  await slot.findByRole("button", { name: "Switch to view only" });
  expect(openSandboxDesktop).toHaveBeenCalledWith({ threadId: "thr_desktop", viewOnly: false });
  expect(slot.getByRole("link", { name: "Open desktop in browser" }).getAttribute("href")).toBe(next.url);
  fireEvent.click(slot.getByRole("button", { name: "Close desktop" }));
  await slot.findByText("Closed");
  expect(closeSandboxDesktop).toHaveBeenCalledWith({ threadId: "thr_desktop" });
  expect(slot.queryByRole("link", { name: "Open desktop in browser" })).toBeNull();
});

it("does not offer a browser link for an unsafe or expired grant", async () => {
  const unsafe = renderSlot(card, props, {
    rpc: { getSandboxDesktop: async () => desktop("javascript:alert(1)") } as never,
  });
  await unsafe.findByText(/View only/);
  expect(unsafe.queryByRole("link")).toBeNull();
  unsafe.unmount();

  const expired = renderSlot(card, props, {
    rpc: { getSandboxDesktop: async () => desktop("https://viewer.example/#expired", true, Date.now() - 1) } as never,
  });
  await expired.findByText("Closed");
  expect(expired.queryByRole("link")).toBeNull();
});
