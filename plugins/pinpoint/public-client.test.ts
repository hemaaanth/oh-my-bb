// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_REVIEW_CLIENT_JS } from "./lib/public-review-client.generated";
import { PICKER_PROTOCOL_VERSION } from "./lib/protocol";


afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("public Pinpoint client", () => {
  it("refuses a legacy review server without loading its webpage or making writes", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    window.eval(PUBLIC_REVIEW_CLIENT_JS);
    const root = document.createElement("div");
    document.body.append(root);
    const review = (window as typeof window & {
      PinpointPublicReview: { mount(config: Record<string, unknown>): void };
    }).PinpointPublicReview;
    review.mount({ root, threadId: "synthetic-thread", target: "https://preview.example.test/", proxyBase: "./proxy" });
    expect(root.querySelector("iframe")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mounts a sandboxed review without owner browser chrome", async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      url === "./api/feedback" ? Response.json({ ok: true, capture: { captureId: "pp_syntheticcapture" } }) :
      Response.json({
        share: { id: "share-1" },
        navigation: {
          url: "https://example.com/",
          revision: 0,
        },
        pinpointRows: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 800, 600));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          this.callback(
            [
              {
                target,
                contentRect: new DOMRectReadOnly(0, 0, 800, 600),
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
    window.eval(PUBLIC_REVIEW_CLIENT_JS);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const publicReview = (
      window as typeof window & {
        PinpointPublicReview: {
          unmount(): void;
          mount(config: Record<string, unknown>): void;
        };
      }
    ).PinpointPublicReview;

    publicReview.mount({
      isolationVersion: 1, screenshotUploadUrl: "./api/screenshot-upload",
      permissions: { capture: true, reply: true, delete: true },
      root,
      threadId: "thread-1",
      target: "https://example.com/",
      proxyBase: "./sandbox/proxy-token/proxy",
      stateUrl: "./api/state",
      feedbackUrl: "./api/feedback",
      navigationUrl: "./api/navigation",
      screenshotUrl: "./api/pinpoint-screenshot",
      csrf: "csrf-1",
    });

    await vi.waitFor(() => {
      expect(root.querySelector("iframe")).not.toBeNull();
    });
    expect(root.querySelector('[aria-label="Back"]')).toBeNull();
    await vi.waitFor(() => {
      expect(
        root.querySelector<HTMLButtonElement>(
          '[aria-label="Pinpoint feedback"]',
        ),
      ).not.toBeNull();
    });
    const iframe = root.querySelector("iframe")!;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "null",
        data: {
          source: "bb-pinpoint",
          type: "pick",
          payload: {
            url: "https://example.com/",
            comment: "Move this control",
          },
        },
      }),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "./api/feedback"),
    ).toHaveLength(0);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "null",
        data: {
          source: "bb-pinpoint",
          type: "ready",
          url: "https://example.com/",
          protocol: PICKER_PROTOCOL_VERSION,
          authToken: "trusted-picker-token",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "null",
        data: {
          source: "bb-pinpoint",
          type: "toggle",
          authToken: "forged-token",
        },
      }),
    );
    expect(
      root.querySelector('[aria-label="Pinpoint feedback"]'),
    ).not.toBeNull();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "null",
        data: {
          source: "bb-pinpoint",
          type: "toggle",
          authToken: "trusted-picker-token",
        },
      }),
    );
    await vi.waitFor(() => {
      expect(root.querySelector('[aria-label="Pinpoint feedback"]')).toBeNull();
    });
    expect(root.querySelector('[aria-keyshortcuts="I"]')).toBeNull();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true }),
    );
    expect(root.querySelector('[aria-label="Pinpoint feedback"]')).toBeNull();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => {
      expect(
        root.querySelector('[aria-label="Pinpoint feedback"]'),
      ).not.toBeNull();
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "null",
        data: {
          source: "bb-pinpoint",
          type: "ready",
          url: "https://example.com/",
          protocol: PICKER_PROTOCOL_VERSION,
          authToken: "trusted-picker-token",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "null",
        data: {
          source: "bb-pinpoint",
          type: "pick",
          authToken: "trusted-picker-token",
          payload: {
            url: "https://example.com/",
            comment: "Move this control",
          },
        },
      }),
    );
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "./api/feedback")).toHaveLength(0);
    const send = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === "Send")!;
    send.click();
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => url === "./api/feedback")).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        origin: "null",
        data: {
          source: "bb-pinpoint",
          type: "intent",
          authToken: "trusted-picker-token",
          id: "pp_1",
          action: "approve",
        },
      }),
    );
    // A preview cannot request an action on an annotation that was not sent
    // to this thread and page, even with the current picker handshake token.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === "./api/feedback")).toHaveLength(1);
    publicReview.unmount();
  });
});
