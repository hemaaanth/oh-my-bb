import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { PICKER_JS, proxyShim } from "./server";
import { PICKER_PROTOCOL_VERSION } from "./lib/protocol";

/**
 * Boot the picker in jsdom with `window.parent.postMessage` intercepted
 * (in jsdom `window.parent === window`) and `elementFromPoint` stubbed —
 * jsdom does no layout, so hit-testing must be simulated.
 */
function bootPicker(html: string, options?: { screenshots?: boolean }) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://sandbox.example.test/page",
  });
  const posted: Record<string, unknown>[] = [];
  (dom.window as unknown as Record<string, unknown>).postMessage = (
    message: Record<string, unknown>,
  ) => {
    posted.push(message);
  };
  if (options?.screenshots === false)
    dom.window.localStorage.setItem("pinpoint.screenshots.enabled", "false");
  dom.window.eval(PICKER_JS);
  const send = (data: Record<string, unknown>) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
  return { dom, posted, send };
}

/** Enter pick mode and click `el`, returning the create popup. */
function pickElement(
  dom: JSDOM,
  send: (data: Record<string, unknown>) => void,
  el: Element,
) {
  (dom.window.document as unknown as Record<string, unknown>).elementFromPoint =
    () => el;
  send({ __pinpoint: true, cmd: "setPick", active: true });
  el.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 60,
    }),
  );
  return dom.window.document.querySelector<HTMLElement>(".pp-pop");
}

describe("Pinpoint injected browser scripts", () => {

  it("provides ephemeral storage when the public sandbox has an opaque origin", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      runScripts: "outside-only",
    });

    try {
      dom.window.eval(`
        for (const name of ["localStorage", "sessionStorage"]) {
          Object.defineProperty(window, name, {
            configurable: true,
            get() { throw new DOMException(name + " is unavailable", "SecurityError"); },
          });
        }
      `);
      expect(() => dom.window.eval("localStorage")).toThrow();

      dom.window.eval(
        proxyShim(
          "https://sandbox.example.test/start",
          "https://bb.example.test/api/v1/plugins/pinpoint/http/proxy",
        ),
      );
      dom.window.eval('localStorage.setItem("banner", "hidden")');

      expect(dom.window.eval('localStorage.getItem("banner")')).toBe("hidden");
      expect(dom.window.eval("localStorage.length")).toBe(1);
      expect(dom.window.eval("localStorage.key(0)")).toBe("banner");
      expect(dom.window.eval('sessionStorage.getItem("banner")')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it("keeps page links navigational while proxying resources and SPA history", () => {
    const proxyPath = "/api/v1/plugins/pinpoint/http/preview/synthetic-capability";
    const targetOrigin = "https://sandbox.example.test";
    const dom = new JSDOM(
      `<!doctype html><html><head><base href="${targetOrigin}/"></head><body></body></html>`,
      {
        runScripts: "outside-only",
        url: `https://bb.example.test${proxyPath}/`,
      },
    );

    try {
      dom.window.eval(proxyShim(`${targetOrigin}/`, proxyPath));

      const anchor = dom.window.document.createElement("a");
      anchor.setAttribute("href", "/compare/the-graph");
      expect(anchor.getAttribute("href")).toBe("/compare/the-graph");
      expect(anchor.href).toBe(`${targetOrigin}/compare/the-graph`);

      const stylesheet = dom.window.document.createElement("link");
      stylesheet.setAttribute("href", "/styles.css");
      expect(stylesheet.getAttribute("href")).toBe(
        `${proxyPath}/styles.css`,
      );

      let navigationEvents = 0;
      dom.window.addEventListener("bb-pinpoint-navigation", () => {
        navigationEvents += 1;
      });
      dom.window.history.pushState({}, "", "/compare/the-graph");

      expect(dom.window.eval("window.__pinpointTargetUrl().href")).toBe(`${targetOrigin}/compare/the-graph`);
      expect(navigationEvents).toBe(1);

      const alreadyWrapped = `${proxyPath}/compare/subgraphs`;
      dom.window.history.replaceState({}, "", alreadyWrapped);

      expect(dom.window.eval("window.__pinpointTargetUrl().href")).toBe(`${targetOrigin}/compare/subgraphs`);
      expect(navigationEvents).toBe(2);
    } finally {
      dom.window.close();
    }
  });

  it("proxies responsive image URLs assigned through srcset at runtime", () => {
    const proxyPath = "/api/v1/plugins/pinpoint/http/preview/synthetic-capability";
    const targetOrigin = "https://sandbox.example.test";
    const dom = new JSDOM(
      `<!doctype html><html><head><base href="${targetOrigin}/"></head><body></body></html>`,
      {
        runScripts: "outside-only",
        url: `https://bb.example.test${proxyPath}/`,
      },
    );

    try {
      const proxiedCurrentSrc = `${proxyPath}/photos/s763-480.webp`;
      Object.defineProperty(dom.window.HTMLImageElement.prototype, "currentSrc", {
        configurable: true,
        get: () => proxiedCurrentSrc,
      });
      dom.window.eval(proxyShim(`${targetOrigin}/`, proxyPath));

      const image = dom.window.document.createElement("img");
      image.srcset = "/photos/s763-480.webp 480w, /photos/s763-960.webp 960w";

      expect(image.getAttribute("srcset")).toBe(
        `${proxyPath}/photos/s763-480.webp 480w, ${proxyPath}/photos/s763-960.webp 960w`,
      );
      expect(image.currentSrc).toBe(
        `${targetOrigin}/photos/s763-480.webp`,
      );
    } finally {
      dom.window.close();
    }
  });

  it("keeps same-origin links inside the review and leaves cross-origin links alone", () => {
    const { dom } = bootPicker(
      '<!doctype html><html><head><base href="https://sandbox.example.test/page"></head><body></body></html>',
    );
    try {
      const sameOrigin = dom.window.document.createElement("a");
      sameOrigin.href = "https://sandbox.example.test/page#details";
      dom.window.document.body.appendChild(sameOrigin);
      const sameOriginClick = new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      sameOrigin.dispatchEvent(sameOriginClick);
      expect(sameOriginClick.defaultPrevented).toBe(true);
      expect(dom.window.location.hash).toBe("#details");

      const crossOrigin = dom.window.document.createElement("a");
      crossOrigin.href = "https://example.com/escape";
      dom.window.document.body.appendChild(crossOrigin);
      const crossOriginClick = new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      crossOrigin.dispatchEvent(crossOriginClick);
      expect(crossOriginClick.defaultPrevented).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it("reports the protocol version in its ready message", () => {
    vi.useFakeTimers();
    const dom = new JSDOM(
      "<!doctype html><html><body></body></html>",
      { runScripts: "outside-only", url: "https://sandbox.example.test/page" },
    );

    try {
      // In jsdom `window.parent === window`, so the picker's
      // `window.parent.postMessage` is interceptable directly.
      const posted: Record<string, unknown>[] = [];
      (dom.window as unknown as Record<string, unknown>).postMessage = (
        message: Record<string, unknown>,
      ) => {
        posted.push(message);
      };
      dom.window.eval(PICKER_JS);
      dom.window.dispatchEvent(new dom.window.Event("load"));
      vi.runAllTimers();

      const ready = posted.find((m) => m.type === "ready");
      expect(ready).toBeDefined();
      expect(ready?.source).toBe("bb-pinpoint");
      expect(ready?.protocol).toBe(PICKER_PROTOCOL_VERSION);
      expect(ready?.authToken).toEqual(expect.any(String));
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "i",
          bubbles: true,
          cancelable: true,
        }),
      );
      const toggle = posted.find((message) => message.type === "toggle");
      expect(toggle?.authToken).toBe(ready?.authToken);
    } finally {
      vi.useRealTimers();
      dom.window.close();
    }
  });

  it("opens an existing marker while the element picker is active", () => {
    const dom = new JSDOM(
      "<!doctype html><html><head><style>div{opacity:.8!important}</style></head><body><button id=target>Target</button></body></html>",
      { runScripts: "outside-only", url: "https://sandbox.example.test/page" },
    );

    try {
      dom.window.eval(PICKER_JS);
      const send = (data: Record<string, unknown>) =>
        dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
      send({
        __pinpoint: true,
        cmd: "annotations",
        items: [
          {
            id: "pp_1",
            index: 1,
            status: "waiting-input",
            comment: "Clarify this button",
            selector: "#target",
            thread: [
              { role: "human", content: "Clarify this button" },
              { role: "agent", content: "What should change?" },
            ],
            authoredByAgent: false,
          },
        ],
      });
      send({ __pinpoint: true, cmd: "setPick", active: true });

      const marker = dom.window.document.querySelector<HTMLElement>(".pp-mark")!;
      expect(marker.querySelector(".pp-mark-num")?.textContent).toBe("1");
      expect(marker.querySelector(".pp-mark-edit svg")).not.toBeNull();
      marker.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );

      expect(dom.window.document.querySelector(".pp-pop")).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it("captures capped computed styles, bounding box, accessibility and nearby elements on pick", () => {
    const { dom, posted, send } = bootPicker(
      `<!doctype html><html><body>
        <div id="wrap" class="section">
          <h2 id="sib-title">Billing</h2>
          <button id="save-btn" class="btn primary"
            style="display:flex;color:rgb(10, 20, 30);font-size:14px"
            aria-label="Save" aria-expanded="false">Save</button>
          <p class="hint">Charges apply monthly</p>
        </div>
      </body></html>`,
    );
    try {
      const el = dom.window.document.getElementById("save-btn")!;
      const pop = pickElement(dom, send, el);
      expect(pop).not.toBeNull();

      const ta = pop!.querySelector("textarea")!;
      ta.value = "make it green";
      ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      pop!
        .querySelector<HTMLButtonElement>(".pp-send")!
        .dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );

      const pick = posted.find((m) => m.type === "pick");
      expect(pick).toBeDefined();
      const payload = pick!.payload as Record<string, unknown>;

      const styles = payload.computedStyles as string;
      expect(styles).toContain("color");
      expect(styles.length).toBeLessThanOrEqual(500);

      const rect = payload.rect as Record<string, unknown>;
      expect(rect).toBeTruthy();
      expect(typeof rect.x).toBe("number");
      expect(typeof rect.y).toBe("number");
      expect(typeof rect.w).toBe("number");
      expect(typeof rect.h).toBe("number");

      const ax = payload.accessibility as string;
      expect(ax).toContain('name="Save"');
      expect(ax).toContain("aria-expanded");
      expect(ax.length).toBeLessThanOrEqual(200);

      const near = payload.nearbyElements as string;
      expect(near).toContain("h2");
      expect((near.match(/ \| /g) ?? []).length).toBeLessThanOrEqual(4);
      expect(near.length).toBeLessThanOrEqual(300);

      // Client-side durable anchor: id generated in the picker, stamped on
      // the element, and carried in the payload for the server to adopt.
      const clientId = payload.clientId as string;
      expect(clientId).toMatch(/^pp_[a-z0-9]{4,24}$/);
      expect(el.getAttribute("data-pp")).toBe(clientId);

      expect(payload.comment).toBe("make it green");
    } finally {
      dom.window.close();
    }
  });

  it("uses one compact composer row and defaults feedback to fix/suggestion", () => {
    const { dom, posted, send } = bootPicker(
      '<!doctype html><html><head><style>div{opacity:.8!important}textarea,button{background:#444!important;border-color:#444!important;color:#aaa!important}</style></head><body><button id=t>Go</button></body></html>',
    );
    try {
      const el = dom.window.document.getElementById("t")!;
      const pop = pickElement(dom, send, el);
      expect(pop).not.toBeNull();
      expect(pop!.classList.contains("pp-pop-create")).toBe(true);
      expect(pop!.querySelector(".pp-segs")).toBeNull();

      const composer = pop!.querySelector(".pp-compose")!;
      expect(composer.children).toHaveLength(3);
      const question = composer.querySelector<HTMLElement>(".pp-question")!;
      const sendButton = composer.querySelector<HTMLElement>(".pp-send")!;
      expect(dom.window.getComputedStyle(question).width).toBe("40px");
      expect(dom.window.getComputedStyle(sendButton).width).toBe("40px");
      expect(dom.window.getComputedStyle(question).height).toBe("40px");
      expect(dom.window.getComputedStyle(sendButton).height).toBe("40px");
      expect(dom.window.getComputedStyle(composer).borderTopWidth).toBe("0px");
      expect(dom.window.getComputedStyle(pop!).padding).toBe("0px");
      expect(dom.window.getComputedStyle(composer).opacity).toBe("1");
      const pendingMarker = Array.from(
        dom.window.document.querySelectorAll<HTMLElement>(".pp-mark"),
      ).find((marker) => marker.textContent === "+")!;
      expect(dom.window.getComputedStyle(pendingMarker).opacity).toBe("1");
      expect(dom.window.getComputedStyle(pop!).backgroundColor).toBe(
        "rgba(0, 0, 0, 0)",
      );
      const textareaElement = composer.querySelector<HTMLElement>("textarea")!;
      expect(dom.window.getComputedStyle(textareaElement).boxSizing).toBe(
        "border-box",
      );
      expect(dom.window.getComputedStyle(textareaElement).height).toBe("40px");
      expect(dom.window.getComputedStyle(textareaElement).borderRadius).toBe(
        "20px",
      );
      expect(dom.window.getComputedStyle(question).borderRadius).toBe("20px");
      expect(dom.window.getComputedStyle(sendButton).borderRadius).toBe("20px");
      expect(dom.window.getComputedStyle(question).boxSizing).toBe("border-box");
      expect(dom.window.getComputedStyle(sendButton).boxSizing).toBe("border-box");
      expect(
        Array.from(dom.window.document.querySelectorAll("style")).some((style) =>
          style.textContent?.includes(
            ".pp-pop textarea::-webkit-scrollbar-button{display:none",
          ),
        ),
      ).toBe(true);
      const textareaStyle = dom.window.getComputedStyle(textareaElement);
      const questionStyle = dom.window.getComputedStyle(question);
      const sendStyle = dom.window.getComputedStyle(sendButton);
      expect(questionStyle.backgroundColor).toBe(textareaStyle.backgroundColor);
      expect(sendStyle.backgroundColor).toBe(textareaStyle.backgroundColor);
      expect(questionStyle.borderTopColor).toBe(textareaStyle.borderTopColor);
      expect(sendStyle.borderTopColor).toBe(textareaStyle.borderTopColor);
      expect(textareaStyle.backgroundColor).toBe("rgb(23, 23, 23)");
      expect(textareaStyle.borderTopColor).toBe("rgb(38, 38, 38)");
      expect(composer.querySelector("textarea")).not.toBeNull();
      expect(composer.querySelector(".pp-question")).not.toBeNull();
      expect(composer.querySelector(".pp-send")).not.toBeNull();

      const textarea = composer.querySelector("textarea")!;
      textarea.value = "make the button clearer";
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      composer.querySelector<HTMLButtonElement>(".pp-send")!.click();

      const pick = posted.find((message) => message.type === "pick");
      expect(pick).toBeDefined();
      const payload = pick!.payload as Record<string, unknown>;
      expect(payload.intent).toBe("fix");
      expect(payload.severity).toBe("suggestion");
      expect(
        Array.from(dom.window.document.querySelectorAll(".pp-mark")).some(
          (marker) => marker.textContent === "+",
        ),
      ).toBe(true);
      send({
        __pinpoint: true,
        cmd: "annotations",
        items: [
          {
            id: payload.clientId,
            index: 1,
            status: "open",
            x: 50,
            y: 60,
          },
        ],
      });
      expect(
        Array.from(dom.window.document.querySelectorAll(".pp-mark")).some(
          (marker) => marker.textContent === "+",
        ),
      ).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it("uses an outside click only to dismiss an open comment composer", () => {
    const { dom, posted, send } = bootPicker(
      "<!doctype html><html><body><button id=first>First</button><button id=second>Second</button></body></html>",
    );
    try {
      const first = dom.window.document.getElementById("first")!;
      const second = dom.window.document.getElementById("second")!;
      let hit = first;
      (
        dom.window.document as unknown as Record<string, unknown>
      ).elementFromPoint = () => hit;
      send({ __pinpoint: true, cmd: "setPick", active: true });

      first.dispatchEvent(
        new dom.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }),
      );
      expect(dom.window.document.querySelector(".pp-pop")).not.toBeNull();

      hit = second;
      second.dispatchEvent(
        new dom.window.MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 40,
        }),
      );
      const dismissClick = new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 40,
      });
      second.dispatchEvent(dismissClick);

      expect(dismissClick.defaultPrevented).toBe(true);
      expect(dom.window.document.querySelector(".pp-pop")).toBeNull();
      expect(
        Array.from(dom.window.document.querySelectorAll(".pp-mark")).some(
          (marker) => marker.textContent === "+",
        ),
      ).toBe(false);
      expect(posted.find((message) => message.type === "pick")).toBeUndefined();

      second.dispatchEvent(
        new dom.window.MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 40,
        }),
      );
      second.dispatchEvent(
        new dom.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 40,
        }),
      );
      expect(dom.window.document.querySelector(".pp-pop")).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });


  it("uses one question toggle instead of intent and severity matrices", () => {
    const { dom, posted, send } = bootPicker(
      "<!doctype html><html><body><button id=t>Go</button></body></html>",
    );
    try {
      const el = dom.window.document.getElementById("t")!;
      const pop = pickElement(dom, send, el)!;
      const question = pop.querySelector<HTMLButtonElement>(".pp-question")!;
      expect(question.getAttribute("aria-pressed")).toBe("false");
      expect(question.querySelector("svg")?.dataset.modeIcon).toBe("writing");
      expect(dom.window.getComputedStyle(question).color).toBe("rgb(240, 240, 240)");

      question.click();
      expect(question.getAttribute("aria-pressed")).toBe("true");
      expect(question.querySelector("svg")?.dataset.modeIcon).toBe("question");
      const textarea = pop.querySelector("textarea")!;
      expect(textarea.getAttribute("placeholder")).toBe("Ask a question…");
      textarea.value = "Should this open in a new tab?";
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      pop.querySelector<HTMLButtonElement>(".pp-send")!.click();

      const pick = posted.find((message) => message.type === "pick");
      expect(pick).toBeDefined();
      expect((pick!.payload as Record<string, unknown>).intent).toBe("question");
    } finally {
      dom.window.close();
    }
  });
  it("grows the composer to the viewport before enabling its scrollbar", () => {
    const { dom, send } = bootPicker(
      "<!doctype html><html><body><button id=t>Go</button></body></html>",
    );
    try {
      Object.defineProperty(dom.window, "innerHeight", {
        configurable: true,
        value: 240,
      });
      const pop = pickElement(
        dom,
        send,
        dom.window.document.getElementById("t")!,
      )!;
      const textarea = pop.querySelector<HTMLTextAreaElement>("textarea")!;
      Object.defineProperty(textarea, "scrollHeight", {
        configurable: true,
        value: 180,
      });
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(textarea.style.height).toBe("180px");
      expect(textarea.style.overflowY).toBe("hidden");

      Object.defineProperty(textarea, "scrollHeight", {
        configurable: true,
        value: 600,
      });
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(textarea.style.height).toBe("224px");
      expect(textarea.style.overflowY).toBe("auto");
    } finally {
      dom.window.close();
    }
  });

  it("uses I for the unified picker toggle and keeps toolbar shortcuts scoped", () => {
    const { dom, posted, send } = bootPicker(
      "<!doctype html><html><body><p>Copy</p></body></html>",
    );
    try {
      send({ __pinpoint: true, cmd: "panel", open: true });
      posted.length = 0;
      for (const key of ["y", "u", "i", "e", "c"]) {
        dom.window.document.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      expect(posted.map((message) => message.type)).toEqual([
        "screenshot",
        "toggle",
        "eye",
      ]);
    } finally {
      dom.window.close();
    }
  });
  it("suppresses native link cursors and uses a precise comment pointer", () => {
    const { dom, send } = bootPicker(
      '<!doctype html><html><body><a id=link href="#" style="cursor:pointer">Learn more</a></body></html>',
    );
    try {
      const link = dom.window.document.getElementById("link")!;
      Object.defineProperty(dom.window.document, "elementFromPoint", {
        configurable: true,
        value: () => link,
      });
      send({ __pinpoint: true, cmd: "setPick", active: true });
      link.dispatchEvent(
        new dom.window.MouseEvent("mousemove", {
          bubbles: true,
          clientX: 12,
          clientY: 14,
        }),
      );

      expect(dom.window.document.documentElement.classList).toContain(
        "pp-picking",
      );
      expect(dom.window.document.querySelector("style")?.textContent).toContain(
        ".pp-picking,.pp-picking *{cursor:none!important}",
      );
      const cursor =
        dom.window.document.querySelector<HTMLElement>(".pp-cursor")!;
      expect(cursor.style.display).toBe("flex");
      expect(
        dom.window.document.querySelector<HTMLElement>(".pp-hi")!.style.display,
      ).toBe("none");
      const pickerCss =
        dom.window.document.querySelector("style")?.textContent ?? "";
      expect(pickerCss).toContain("border-radius:2px 15px 15px 15px");
      expect(pickerCss).toContain("transform:translate(1px,-1px)");

      send({ __pinpoint: true, cmd: "setPick", active: false });
      expect(dom.window.document.documentElement.classList).not.toContain(
        "pp-picking",
      );
      expect(dom.window.getComputedStyle(link).cursor).toBe("pointer");
    } finally {
      dom.window.close();
    }
  });
  it("keeps the hovered outline attached to its element while scrolling", () => {
    const { dom, send } = bootPicker(
      "<!doctype html><html><body><div id=target>Target</div></body></html>",
    );
    try {
      const target = dom.window.document.getElementById("target")!;
      let top = 120;
      target.getBoundingClientRect = () =>
        ({
          left: 40,
          top,
          width: 200,
          height: 80,
          right: 240,
          bottom: top + 80,
          x: 40,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
      Object.defineProperty(dom.window.document, "elementFromPoint", {
        configurable: true,
        value: () => target,
      });
      send({
        __pinpoint: true,
        cmd: "preferences",
        showElementOutline: true,
      });
      send({ __pinpoint: true, cmd: "setPick", active: true });
      target.dispatchEvent(
        new dom.window.MouseEvent("mousemove", {
          bubbles: true,
          clientX: 50,
          clientY: 130,
        }),
      );

      const outline =
        dom.window.document.querySelector<HTMLElement>(".pp-hi")!;
      expect(outline.style.top).toBe("120px");

      top = 35;
      dom.window.dispatchEvent(new dom.window.Event("scroll"));
      expect(outline.style.top).toBe("35px");
    } finally {
      dom.window.close();
    }
  });



  it("still posts the pick when the snapdom screenshot library is missing", () => {
    const { dom, posted, send } = bootPicker(
      "<!doctype html><html><body><button id=t>Go</button></body></html>",
    );
    try {
      // No window.snapdom global (the picker-lib script failed to load):
      // the screenshot capture must silently skip, never block the pick.
      expect(
        (dom.window as unknown as Record<string, unknown>).snapdom,
      ).toBeUndefined();
      const el = dom.window.document.getElementById("t")!;
      const pop = pickElement(dom, send, el);
      expect(pop).not.toBeNull();

      const ta = pop!.querySelector("textarea")!;
      ta.value = "still works";
      ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(() =>
        pop!
          .querySelector<HTMLButtonElement>(".pp-send")!
          .dispatchEvent(
            new dom.window.MouseEvent("click", {
              bubbles: true,
              cancelable: true,
            }),
          ),
      ).not.toThrow();

      const pick = posted.find((m) => m.type === "pick");
      expect(pick).toBeDefined();
      expect((pick!.payload as Record<string, unknown>).comment).toBe(
        "still works",
      );
    } finally {
      dom.window.close();
    }
  });

  it("skips screenshot work and reports that preference when capture is disabled", async () => {
    vi.useFakeTimers();
    const { dom, posted, send } = bootPicker(
      "<!doctype html><html><body><button id=t>Go</button></body></html>",
      { screenshots: false },
    );
    try {
      const toCanvas = vi.fn(() => Promise.resolve({ width: 500, height: 400 }));
      (dom.window as unknown as Record<string, unknown>).snapdom = { toCanvas };
      const pop = pickElement(dom, send, dom.window.document.getElementById("t")!);
      const ta = pop!.querySelector("textarea")!;
      ta.value = "no screenshot please";
      ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      pop!.querySelector<HTMLButtonElement>(".pp-send")!.click();

      await vi.runAllTimersAsync();
      expect(toCanvas).not.toHaveBeenCalled();
      const pick = posted.find((m) => m.type === "pick")!;
      expect((pick.payload as Record<string, unknown>).screenshotExpected).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
      dom.window.close();
    }
  });

  it("captures the nearest semantic control instead of the exact text span", async () => {
    vi.useFakeTimers();
    const { dom, posted, send } = bootPicker(
      "<!doctype html><html><body><button id=t><span id=label>Go</span></button></body></html>",
    );
    try {
      const el = dom.window.document.getElementById("t")!;
      el.getBoundingClientRect = () =>
        ({
          x: 120,
          y: 80,
          left: 120,
          top: 80,
          right: 220,
          bottom: 120,
          width: 100,
          height: 40,
          toJSON: () => ({}),
        }) as DOMRect;
      const shot = dom.window.document.createElement("canvas");
      shot.width = 100;
      shot.height = 40;
      const toCanvas = vi.fn(() => Promise.resolve(shot));
      (dom.window as unknown as Record<string, unknown>).snapdom = {
        toCanvas,
      };
      vi.spyOn(dom.window.HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
        "data:image/webp;base64,dGVzdA==",
      );
      const fetch = vi.fn(() => Promise.resolve({ ok: true }));
      (dom.window as unknown as Record<string, unknown>).fetch = fetch;

      const pop = pickElement(dom, send, dom.window.document.getElementById("label")!)!;
      const ta = pop.querySelector("textarea")!;
      ta.value = "capture this element";
      ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      pop.querySelector<HTMLButtonElement>(".pp-send")!.click();
      await vi.runAllTimersAsync();

      expect(
        (posted.find((m) => m.type === "pick")!.payload as Record<string, unknown>)
          .screenshotExpected,
      ).toBe(true);
      expect(toCanvas).toHaveBeenCalledOnce();
      expect(toCanvas.mock.calls[0]![0]).toBe(el);
      expect(toCanvas.mock.calls[0]![1]).toEqual({
        scale: 1,
        dpr: 1,
        fast: true,
        backgroundColor: "#fff",
      });
      expect(fetch).not.toHaveBeenCalled();
      const shotMessage = posted.find((message) => message.type === "screenshot-upload");
      expect(shotMessage).toMatchObject({
        clientId: (posted.find((message) => message.type === "pick")!.payload as Record<string, unknown>).clientId,
        screenshot: "dGVzdA==",
        kind: "element",
        mime: "image/webp",
      });
    } finally {
      vi.useRealTimers();
      dom.window.close();
    }
  });

  it("re-anchors markers via data-pp before the CSS selector, else falls back to coordinates", () => {
    const { dom, send } = bootPicker(
      `<!doctype html><html><body>
        <div id="host"><button data-pp="pp_a1">Moved</button></div>
        <span id="stampme">hello</span>
      </body></html>`,
    );
    try {
      send({
        __pinpoint: true,
        cmd: "annotations",
        items: [
          // Selector broken, data-pp present → anchor wins (element rect 0,0).
          {
            id: "pp_a1",
            index: 1,
            status: "open",
            comment: "a",
            selector: "#does-not-exist",
            x: 333,
            y: 222,
            thread: [],
          },
          // Selector broken, no data-pp → coordinate fallback.
          {
            id: "pp_b2",
            index: 2,
            status: "open",
            comment: "b",
            selector: "#also-gone",
            x: 333,
            y: 222,
            thread: [],
          },
          // Selector matches → element is stamped with data-pp on render.
          {
            id: "pp_c3",
            index: 3,
            status: "open",
            comment: "c",
            selector: "#stampme",
            x: 1,
            y: 1,
            thread: [],
          },
        ],
      });
      const markers = Array.from(
        dom.window.document.querySelectorAll<HTMLElement>(".pp-mark"),
      );
      const byIndex = (n: string) =>
        markers.find(
          (m) => m.querySelector(".pp-mark-num")?.textContent === n,
        )!;
      // jsdom rects are all-zero, so the element-anchored marker keeps the
      // configured 18px viewport edge gap beyond its 11px radius.
      expect(byIndex("1").style.left).toBe("29px");
      expect(byIndex("2").style.left).toBe("333px");
      expect(
        dom.window.document.getElementById("stampme")?.getAttribute("data-pp"),
      ).toBe("pp_c3");
    } finally {
      dom.window.close();
    }
  });

  it("places pins at their click offset and separates legacy pins sharing an anchor", () => {
    const { dom, send } = bootPicker(
      "<!doctype html><html><body><div id=target>Target</div></body></html>",
    );
    try {
      const el = dom.window.document.getElementById("target")!;
      el.getBoundingClientRect = () =>
        ({
          x: 100,
          y: 80,
          left: 100,
          top: 80,
          right: 300,
          bottom: 140,
          width: 200,
          height: 60,
          toJSON: () => ({}),
        }) as DOMRect;
      send({
        __pinpoint: true,
        cmd: "annotations",
        items: [
          {
            id: "pp_exact",
            index: 1,
            status: "open",
            selector: "#target",
            anchorOffsetX: 125,
            anchorOffsetY: 35,
          },
          { id: "pp_old1", index: 2, status: "open", selector: "#target" },
          { id: "pp_old2", index: 3, status: "open", selector: "#target" },
        ],
      });

      const markers = Array.from(
        dom.window.document.querySelectorAll<HTMLElement>(".pp-mark"),
      );
      const byIndex = (index: string) =>
        markers.find((m) => m.querySelector(".pp-mark-num")?.textContent === index)!;
      expect(byIndex("1").style.left).toBe("225px");
      expect(byIndex("1").style.top).toBe("115px");
      expect(byIndex("2").style.left).not.toBe(byIndex("3").style.left);
      const shiftedLeft = byIndex("3").style.left;
      send({
        __pinpoint: true,
        cmd: "reveal",
        item: { id: "pp_old2", selector: "#target", status: "open" },
      });
      expect(byIndex("3").style.left).toBe(shiftedLeft);
      expect(byIndex("3").classList.contains("pp-reveal")).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it("spreads duplicate markers inward and keeps their centers in the viewport", () => {
    const { dom, send } = bootPicker(
      "<!doctype html><html><body><div id=target>Target</div></body></html>",
    );
    try {
      Object.defineProperty(dom.window, "innerWidth", {
        configurable: true,
        value: 300,
      });
      const el = dom.window.document.getElementById("target")!;
      el.getBoundingClientRect = () =>
        ({
          x: 295,
          y: 40,
          left: 295,
          top: 40,
          right: 300,
          bottom: 60,
          width: 5,
          height: 20,
          toJSON: () => ({}),
        }) as DOMRect;
      send({
        __pinpoint: true,
        cmd: "annotations",
        items: [
          { id: "pp_edge1", index: 1, status: "open", selector: "#target" },
          { id: "pp_edge2", index: 2, status: "open", selector: "#target" },
        ],
      });

      const lefts = Array.from(
        dom.window.document.querySelectorAll<HTMLElement>(".pp-mark"),
      ).map((marker) => Number.parseFloat(marker.style.left));
      expect(lefts).toEqual([271, 247]);
      expect(new Set(lefts).size).toBe(2);
    } finally {
      dom.window.close();
    }
  });
  it("pads offscreen markers and points them toward their live anchor", () => {
    const { dom, send } = bootPicker(
      "<!doctype html><html><body><div id=target>Target</div></body></html>",
    );
    try {
      Object.defineProperty(dom.window, "innerWidth", {
        configurable: true,
        value: 300,
      });
      Object.defineProperty(dom.window, "innerHeight", {
        configurable: true,
        value: 200,
      });
      let top = -80;
      const el = dom.window.document.getElementById("target")!;
      el.getBoundingClientRect = () =>
        ({
          x: 100,
          y: top,
          left: 100,
          top,
          right: 140,
          bottom: top + 40,
          width: 40,
          height: 40,
          toJSON: () => ({}),
        }) as DOMRect;
      send({
        __pinpoint: true,
        cmd: "annotations",
        items: [
          { id: "pp_above", index: 1, status: "open", selector: "#target" },
        ],
      });

      const marker =
        dom.window.document.querySelector<HTMLElement>(".pp-mark")!;
      expect(marker.style.top).toBe("29px");
      expect(marker.classList).toContain("pp-offscreen");
      expect(Number.parseFloat(marker.style.getPropertyValue("--pp-angle"))).toBe(
        -90,
      );
      expect(
        Number.parseFloat(marker.style.getPropertyValue("--pp-rotation")),
      ).toBe(-135);

      top = 70;
      dom.window.dispatchEvent(new dom.window.Event("scroll"));
      expect(marker.style.top).toBe("70px");
      expect(marker.classList).not.toContain("pp-offscreen");
      expect(marker.style.getPropertyValue("--pp-angle")).toBe("");
      expect(marker.style.getPropertyValue("--pp-rotation")).toBe("");
      const pickerCss = Array.from(
        dom.window.document.querySelectorAll("style"),
      )
        .map((style) => style.textContent ?? "")
        .join("");
      expect(pickerCss).not.toContain(".pp-mark::after");
      expect(pickerCss).toContain(
        "@media (prefers-reduced-motion:reduce){.pp-mark{transition:none}}",
      );
    } finally {
      dom.window.close();
    }
  });


  // Direct text editing (R4). jsdom limitations these tests compensate for
  // (documented, not faked):
  //  * jsdom has no native context menu UI; dispatching `contextmenu` still
  //    exercises the same capture listener used by a real right-click.
  //  * jsdom has no contentEditable editing engine (`isContentEditable` is
  //    not implemented), so "typing" is simulated by mutating `textContent`
  //    while the edit is active, and edit state is asserted via the
  //    `contenteditable` attribute the picker sets.
  //  * jsdom does not move focus on outside clicks, so the blur-commit path
  //    is driven through its equivalent Enter-commit path (both call the
  //    same commit function in the picker).
  describe("direct text editing", () => {
    const keydown = (dom: JSDOM, target: Element | Document, key: string) =>
      target.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
    const rightclick = (dom: JSDOM, el: Element) =>
      el.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 10,
          clientY: 10,
        }),
      );

    it("enters an inline edit on right-click in comment mode and restores on Escape", () => {
      const { dom, posted, send } = bootPicker(
        "<!doctype html><html><body><p id=copy>Hello world</p></body></html>",
      );
      try {
        const el = dom.window.document.getElementById("copy")!;
        Object.defineProperty(dom.window.document, "elementFromPoint", {
          configurable: true,
          value: () => el,
        });
        send({
          __pinpoint: true,
          cmd: "preferences",
          showElementOutline: true,
        });
        send({ __pinpoint: true, cmd: "setPick", active: true });
        el.dispatchEvent(
          new dom.window.MouseEvent("mousemove", {
            bubbles: true,
            clientX: 10,
            clientY: 10,
          }),
        );
        expect(
          dom.window.document.querySelector<HTMLElement>(".pp-hi")!.style
            .display,
        ).toBe("block");
        expect(
          dom.window.document.querySelector<HTMLElement>(".pp-cursor")!.style
            .display,
        ).toBe("flex");
        expect(dom.window.document.body.style.cursor).toBe("none");
        expect(rightclick(dom, el)).toBe(false);
        expect(el.getAttribute("contenteditable")).toBe("true");
        expect(el.classList.contains("pp-editing")).toBe(true);
        expect(
          dom.window.document.querySelector<HTMLElement>(".pp-hi")!.style
            .display,
        ).toBe("none");
        expect(
          dom.window.document.querySelector<HTMLElement>(".pp-tip")!.style
            .display,
        ).toBe("none");
        expect(
          dom.window.document.querySelector<HTMLElement>(".pp-cursor")!.style
            .display,
        ).toBe("none");

        el.textContent = "Howdy world";
        keydown(dom, el, "Escape");
        expect(el.getAttribute("contenteditable")).toBeNull();
        expect(el.classList.contains("pp-editing")).toBe(false);
        expect(el.textContent).toBe("Hello world");
        expect(posted.find((m) => m.type === "pick")).toBeUndefined();
        expect(dom.window.document.querySelector(".pp-pill")).toBeNull();
      } finally {
        dom.window.close();
      }
    });

    it("restores the original BR and SVG nodes without losing their identity or listeners", () => {
      const { dom, send } = bootPicker(
        '<!doctype html><html><body><h1 id=head>Instant<br id=break>data</h1><button id=cta><svg id=icon aria-hidden="true"></svg>Go</button></body></html>',
      );
      try {
        send({ __pinpoint: true, cmd: "setPick", active: true });
        const head = dom.window.document.getElementById("head")!;
        const br = dom.window.document.getElementById("break")!;
        rightclick(dom, head);
        head.textContent = "Changed";
        keydown(dom, head, "Escape");
        expect(dom.window.document.getElementById("break")).toBe(br);

        const button = dom.window.document.getElementById("cta")!;
        const svg = dom.window.document.getElementById("icon")!;
        let clicks = 0;
        svg.addEventListener("pinpoint-test", () => {
          clicks += 1;
        });
        rightclick(dom, button);
        button.textContent = "Changed";
        keydown(dom, button, "Escape");
        expect(dom.window.document.getElementById("icon")).toBe(svg);
        svg.dispatchEvent(new dom.window.CustomEvent("pinpoint-test"));
        expect(clicks).toBe(1);
      } finally {
        dom.window.close();
      }
    });

    it("ignores Pinpoint toolbar controls when reviews are nested", () => {
      const { dom, posted, send } = bootPicker(
        '<!doctype html><html><body><p id=content>Page content</p><div data-pinpoint-ui><button id=toolbar>1</button></div></body></html>',
      );
      try {
        const button = dom.window.document.getElementById("toolbar")!;
        const content = dom.window.document.getElementById("content")!;
        Object.defineProperty(dom.window.document, "elementFromPoint", {
          configurable: true,
          value: () => content,
        });
        send({
          __pinpoint: true,
          cmd: "preferences",
          showElementOutline: true,
        });
        send({ __pinpoint: true, cmd: "setPick", active: true });
        content.dispatchEvent(
          new dom.window.MouseEvent("mousemove", {
            bubbles: true,
            clientX: 10,
            clientY: 10,
          }),
        );
        expect(
          dom.window.document.querySelector<HTMLElement>(".pp-hi")!.style
            .display,
        ).toBe("block");


        expect(rightclick(dom, button)).toBe(true);
        expect(button.getAttribute("contenteditable")).toBeNull();
        button.dispatchEvent(
          new dom.window.MouseEvent("mousemove", {
            bubbles: true,
            clientX: 10,
            clientY: 10,
          }),
        );
        expect(
          dom.window.document.querySelector<HTMLElement>(".pp-hi")!.style
            .display,
        ).toBe("none");
        button.dispatchEvent(
          new dom.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          }),
        );
        expect(posted.find((message) => message.type === "pick")).toBeUndefined();
      } finally {
        dom.window.close();
      }
    });

    it("leaves the native context menu alone when the comment toolbar is closed", () => {
      const { dom } = bootPicker(
        "<!doctype html><html><body><p id=copy>Hello world</p></body></html>",
      );
      try {
        const el = dom.window.document.getElementById("copy")!;
        expect(rightclick(dom, el)).toBe(true);
        expect(el.getAttribute("contenteditable")).toBeNull();
      } finally {
        dom.window.close();
      }
    });

    it("suppresses the native menu for non-editable page content while commenting", () => {
      const { dom, send } = bootPicker(
        '<!doctype html><html><body><svg id=icon><circle cx="5" cy="5" r="5"/></svg></body></html>',
      );
      try {
        const svg = dom.window.document.getElementById("icon")!;
        send({ __pinpoint: true, cmd: "setPick", active: true });
        expect(rightclick(dom, svg)).toBe(false);
        expect(svg.getAttribute("contenteditable")).toBeNull();
      } finally {
        dom.window.close();
      }
    });

    it("discards a pending edit when clicking outside the confirm pill", () => {
      const { dom, posted, send } = bootPicker(
        "<!doctype html><html><body><p id=copy>Hello world</p></body></html>",
      );
      try {
        const el = dom.window.document.getElementById("copy")!;
        send({
          __pinpoint: true,
          cmd: "preferences",
          confirmTextEdits: true,
        });
        send({ __pinpoint: true, cmd: "setPick", active: true });
        rightclick(dom, el);
        el.textContent = "Howdy world";
        keydown(dom, el, "Enter");

        // Commit attempt → confirm pill, element no longer editable, the
        // edited text still visible pending the decision.
        const pill = dom.window.document.querySelector<HTMLElement>(".pp-pill");
        expect(pill).not.toBeNull();
        expect(el.getAttribute("contenteditable")).toBeNull();
        expect(el.textContent).toBe("Howdy world");

        dom.window.document.body.dispatchEvent(
          new dom.window.MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(dom.window.document.querySelector(".pp-pill")).toBeNull();
        expect(el.textContent).toBe("Hello world");
        const outsideClick = new dom.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        });
        dom.window.document.body.dispatchEvent(outsideClick);
        expect(outsideClick.defaultPrevented).toBe(true);
        expect(dom.window.document.querySelector(".pp-pop")).toBeNull();
        expect(posted.find((m) => m.type === "pick")).toBeUndefined();
      } finally {
        dom.window.close();
      }
    });

    it("does not turn an active text selection into a comment pick", () => {
      const { dom, posted, send } = bootPicker(
        "<!doctype html><html><body><p id=copy>Hello world</p></body></html>",
      );
      try {
        const el = dom.window.document.getElementById("copy")!;
        send({ __pinpoint: true, cmd: "setPick", active: true });
        rightclick(dom, el);
        vi.spyOn(dom.window, "getSelection").mockReturnValue({
          toString: () => "Hello",
          anchorNode: el.firstChild,
          getRangeAt: () => ({ getBoundingClientRect: () => el.getBoundingClientRect() }),
        } as unknown as Selection);

        el.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));

        expect(dom.window.document.querySelector(".pp-pop")).toBeNull();
        expect(el.getAttribute("contenteditable")).toBe("true");
        expect(posted.find((m) => m.type === "pick")).toBeUndefined();
      } finally {
        dom.window.close();
      }
    });

    it("captures text edits immediately by default", () => {
      const { dom, posted, send } = bootPicker(
        "<!doctype html><html><body><p id=copy>Hello world</p></body></html>",
      );
      try {
        const el = dom.window.document.getElementById("copy")!;
        send({ __pinpoint: true, cmd: "setPick", active: true });
        rightclick(dom, el);
        el.textContent = "Howdy world";
        keydown(dom, el, "Enter");

        expect(dom.window.document.querySelector(".pp-pill")).toBeNull();
        const pick = posted.find((message) => message.type === "pick");
        expect(pick).toBeDefined();
        expect((pick!.payload as Record<string, unknown>).textNew).toBe(
          "Howdy world",
        );
      } finally {
        dom.window.close();
      }
    });

    it("confirming captures a text-edit pick with old/new text and intent change, keeping the preview", () => {
      const { dom, posted, send } = bootPicker(
        "<!doctype html><html><body><p id=copy>Hello world</p></body></html>",
      );
      try {
        const el = dom.window.document.getElementById("copy")!;
        send({
          __pinpoint: true,
          cmd: "preferences",
          confirmTextEdits: true,
        });
        send({ __pinpoint: true, cmd: "setPick", active: true });
        rightclick(dom, el);
        el.textContent = "Howdy world";
        keydown(dom, el, "Enter");

        dom.window.document
          .querySelector<HTMLButtonElement>(".pp-pill-ok")!
          .dispatchEvent(
            new dom.window.MouseEvent("click", {
              bubbles: true,
              cancelable: true,
            }),
          );

        const pick = posted.find((m) => m.type === "pick");
        expect(pick).toBeDefined();
        const payload = pick!.payload as Record<string, unknown>;
        expect(payload.kind).toBe("text-edit");
        expect(payload.textOld).toBe("Hello world");
        expect(payload.textNew).toBe("Howdy world");
        expect(payload.intent).toBe("fix");
        expect(payload.screenshotExpected).toBe(false);
        // The element was stamped with the durable anchor like any pick.
        expect(el.getAttribute("data-pp")).toBe(payload.clientId);
        // The edit stays visible in the page as a live preview.
        expect(el.textContent).toBe("Howdy world");
        expect(dom.window.document.querySelector(".pp-pill")).toBeNull();
      } finally {
        dom.window.close();
      }
    });

    it("edits text split by renderer comments and line breaks", () => {
      const { dom, send } = bootPicker(
        "<!doctype html><html><body><h1><span id=head>Instant data for<br>onchain finance</span></h1><p id=sub>The borderless platform <!-- -->&lt;<!-- -->1s latency.</p></body></html>",
      );
      try {
        send({ __pinpoint: true, cmd: "setPick", active: true });
        const head = dom.window.document.getElementById("head")!;
        rightclick(dom, head);
        expect(head.getAttribute("contenteditable")).toBe("true");
        keydown(dom, head, "Escape");

        const sub = dom.window.document.getElementById("sub")!;
        rightclick(dom, sub);
        expect(sub.getAttribute("contenteditable")).toBe("true");
      } finally {
        dom.window.close();
      }
    });

    it("edits a button label without activating an adjacent icon", () => {
      const { dom, send } = bootPicker(
        '<!doctype html><html><body><button id=cta><svg aria-hidden="true"></svg>Get started</button></body></html>',
      );
      try {
        send({ __pinpoint: true, cmd: "setPick", active: true });
        const button = dom.window.document.getElementById("cta")!;
        expect(rightclick(dom, button)).toBe(false);
        expect(button.getAttribute("contenteditable")).toBe("true");
        expect(dom.window.location.href).toBe(
          "https://sandbox.example.test/page",
        );
      } finally {
        dom.window.close();
      }
    });

    it("edits prose with inline formatting and restores its nodes on cancel", () => {
      const { dom, send } = bootPicker(
        "<!doctype html><html><body><p id=mixed>Control <strong id=bold>versus execution</strong>.</p></body></html>",
      );
      try {
        send({ __pinpoint: true, cmd: "setPick", active: true });
        const el = dom.window.document.getElementById("mixed")!;
        const bold = dom.window.document.getElementById("bold")!;
        rightclick(dom, el);
        expect(el.getAttribute("contenteditable")).toBe("true");
        el.textContent = "Changed";
        keydown(dom, el, "Escape");
        expect(dom.window.document.getElementById("bold")).toBe(bold);
        expect(el.textContent).toBe("Control versus execution.");
      } finally {
        dom.window.close();
      }
    });

    it("still declines structural descendants that could be flattened", () => {
      const { dom, send } = bootPicker(
        "<!doctype html><html><body><div id=mixed>text <button>action</button></div></body></html>",
      );
      try {
        send({ __pinpoint: true, cmd: "setPick", active: true });
        const el = dom.window.document.getElementById("mixed")!;
        rightclick(dom, el);
        expect(el.getAttribute("contenteditable")).toBeNull();
      } finally {
        dom.window.close();
      }
    });

    it("does not navigate when a link's text is clicked during an active edit", () => {
      const { dom, send } = bootPicker(
        '<!doctype html><html><body><a id=lnk href="#section">Read more</a></body></html>',
      );
      try {
        const el = dom.window.document.getElementById("lnk")!;
        send({ __pinpoint: true, cmd: "setPick", active: true });
        rightclick(dom, el);
        expect(el.getAttribute("contenteditable")).toBe("true");

        // Without the edit-time suppression, the picker's same-page link
        // handler would set location.hash to #section on this click.
        const click = new dom.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
        expect(dom.window.location.hash).toBe("");
      } finally {
        dom.window.close();
      }
    });
  });

  it("keeps active reveals numbered and reserves pulse markers for resolved comments", () => {
    const { dom, send } = bootPicker(
      '<!doctype html><html><body><button data-pp="pp_active">Target</button></body></html>',
    );
    try {
      const target = dom.window.document.querySelector("[data-pp='pp_active']")!;
      (target as unknown as Record<string, unknown>).scrollIntoView = vi.fn();
      const active = {
        id: "pp_active",
        index: 1,
        status: "waiting-input",
        x: 20,
        y: 20,
      };
      send({ __pinpoint: true, cmd: "annotations", items: [active] });
      send({ __pinpoint: true, cmd: "reveal", item: active });

      const numbered =
        dom.window.document.querySelector<HTMLElement>(".pp-mark")!;
      expect(numbered.textContent).toBe("1");
      expect(numbered.classList).not.toContain("pp-reveal");

      send({ __pinpoint: true, cmd: "annotations", items: [] });
      send({ __pinpoint: true, cmd: "reveal", item: active });
      expect(dom.window.document.querySelector(".pp-reveal")).toBeNull();

      send({
        __pinpoint: true,
        cmd: "reveal",
        item: { ...active, status: "approved" },
      });
      expect(dom.window.document.querySelector(".pp-reveal")).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it("prefers the duplicate data-pp match that also satisfies the stored selector", () => {
    const { dom, send } = bootPicker(
      `<!doctype html><html><body>
        <i data-pp="pp_d4">clone</i>
        <em id="real" data-pp="pp_d4">original</em>
      </body></html>`,
    );
    try {
      const clone = dom.window.document.querySelector("i")!;
      const real = dom.window.document.getElementById("real")!;
      const cloneSpy = vi.fn();
      const realSpy = vi.fn();
      (clone as unknown as Record<string, unknown>).scrollIntoView = cloneSpy;
      (real as unknown as Record<string, unknown>).scrollIntoView = realSpy;
      send({
        __pinpoint: true,
        cmd: "reveal",
        item: {
          id: "pp_d4",
          selector: "#real",
          x: 5,
          y: 5,
          comment: "d",
          status: "open",
        },
      });
      expect(realSpy).toHaveBeenCalled();
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
});
