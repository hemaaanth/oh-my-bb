// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

async function options() {
  document.body.innerHTML = '<form id="pair"><input id="server"><input id="code"><button type="submit">Connect</button><button id="disconnect" type="button">Disconnect</button></form><p id="status"></p>';
  const saved = vi.fn(async () => undefined);
  const request = vi.fn(async () => ({ ok: true, json: async () => ({ token: "t".repeat(43) }) }));
  const message = vi.fn(async () => ({ ok: true }));
  const chrome = { storage: { local: { get: async () => ({}), set: saved, remove: vi.fn() } }, runtime: { sendMessage: message } };
  runInNewContext(await readFile("browser-extension/options.js", "utf8"), { document, chrome, fetch: request, URL, AbortSignal });
  await Promise.resolve();
  const submit = (address: string) => {
    (document.querySelector("#server") as HTMLInputElement).value = address;
    (document.querySelector("#code") as HTMLInputElement).value = "pairing-code";
    document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  };
  return { submit, saved, request, message };
}
it("refuses to send a pairing code over plaintext remote HTTP or a URL with credentials", async () => {
  const { submit, request } = await options();
  submit("http://remote.example.test");
  await waitFor(() => expect(document.querySelector("#status")!.textContent).toContain("Use HTTPS"));
  submit("https://user:password@bb.example.test");
  await waitFor(() => expect(document.querySelector("#status")!.textContent).toContain("base address"));
  expect(request).not.toHaveBeenCalled();
});
