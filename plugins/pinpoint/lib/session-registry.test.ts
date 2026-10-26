// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  attach,
  createSession,
  detach,
  disposeAll,
  getLastSession,
  getSession,
  removeSession,
  reloadSession,
  sessionKey,
} from "./session-registry";

afterEach(() => disposeAll());

describe("Pinpoint browser session registry", () => {
  it("parks and reattaches the same live iframe", () => {
    const session = createSession("thr_1", "https://example.com", "/proxy?u=example");
    const host = document.createElement("div");
    document.body.appendChild(host);

    attach(session, host);
    expect(host.firstElementChild).toBe(session.iframe);
    detach(session);
    expect(session.iframe.isConnected).toBe(true);
    expect(session.iframe.parentElement?.dataset.pinpointHoldingPen).toBe("");
    attach(session, host);
    expect(host.firstElementChild).toBe(session.iframe);
  });

  it("isolates public review content while allowing external links to open", () => {
    const session = createSession(
      "thr_public",
      "https://example.com",
      "/proxy?u=example",
    );

    const permissions = session.iframe.getAttribute("sandbox")!.split(" ");
    expect(permissions).not.toContain("allow-same-origin");
    expect(permissions).not.toContain("allow-popups-to-escape-sandbox");
    expect(permissions).toContain("allow-scripts");
    expect(permissions).toContain("allow-popups");
  });

  it("remembers the last active page for each thread across panel unmounts", () => {
    const first = createSession(
      "thr_1",
      "https://example.com",
      "/proxy?u=example",
    );
    first.currentUrl = "https://example.com/pricing";
    const second = createSession(
      "thr_1",
      "https://example.com/docs",
      "/proxy?u=docs",
    );
    const other = createSession(
      "thr_2",
      "https://other.example.com",
      "/proxy?u=other",
    );

    attach(first, document.createElement("div"));
    detach(first);
    attach(second, document.createElement("div"));
    detach(second);
    attach(other, document.createElement("div"));
    detach(other);

    expect(getLastSession("thr_1")).toBe(second);
    expect(getLastSession("thr_1")?.currentUrl).toBe(
      "https://example.com/docs",
    );
    expect(getLastSession("thr_2")).toBe(other);
  });

  it("does not resurrect a session removed before stale React cleanup", () => {
    const session = createSession("thr_1", "https://example.com", "/proxy?u=example");
    const host = document.createElement("div");
    document.body.appendChild(host);
    attach(session, host);

    removeSession(session.key);
    detach(session);

    expect(session.iframe.isConnected).toBe(false);
    expect(getSession(session.key)).toBeUndefined();
  });

  it("falls back to the remaining page, then clears the thread's last session", () => {
    const first = createSession(
      "thr_1",
      "https://example.com/first",
      "/proxy?u=first",
    );
    const second = createSession(
      "thr_1",
      "https://example.com/second",
      "/proxy?u=second",
    );
    first.lastUsed = 1;
    second.lastUsed = 2;
    attach(first, document.createElement("div"));
    detach(first);
    attach(second, document.createElement("div"));
    detach(second);
    expect(getLastSession("thr_1")).toBe(second);

    removeSession(second.key);
    expect(getLastSession("thr_1")).toBe(first);

    removeSession(first.key);
    expect(getLastSession("thr_1")).toBeUndefined();
  });

  it("keeps at most four unpinned background sessions", () => {
    const created = Array.from({ length: 5 }, (_, index) => {
      const session = createSession(
        "thr_1",
        `https://example.com/${index}`,
        `/proxy?u=${index}`,
      );
      attach(session, document.createElement("div"));
      detach(session);
      return session;
    });

    expect(created[0].iframe.isConnected).toBe(false);
    for (const session of created.slice(1)) {
      expect(getSession(session.key)).toBe(session);
    }
  });

  it("reloads the live session at its current page", () => {
    const session = createSession("thr_1", "https://example.com", "/proxy?u=root");
    session.currentUrl = "https://example.com/the-graph";
    session.connected = true;
    session.frameReady = true;

    reloadSession(
      session,
      session.currentUrl,
      "/proxy?u=https%3A%2F%2Fexample.com%2Fthe-graph",
    );

    expect(session.currentUrl).toBe("https://example.com/the-graph");
    expect(session.iframe.getAttribute("src")).toBe(
      "/proxy?u=https%3A%2F%2Fexample.com%2Fthe-graph",
    );
    expect(session.connected).toBe(false);
    expect(session.frameReady).toBe(false);
  });

  it("disposes every iframe and the holding pen on plugin shutdown", () => {
    const session = createSession("thr_1", "https://example.com", "/proxy?u=example");
    disposeAll();

    expect(session.iframe.isConnected).toBe(false);
    expect(getSession(sessionKey("thr_1", "https://example.com"))).toBeUndefined();
    expect(document.querySelector("[data-pinpoint-holding-pen]")).toBeNull();
  });
});
