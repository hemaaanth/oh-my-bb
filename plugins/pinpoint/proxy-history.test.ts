import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { proxyShim } from "./server";

const target = "https://preview.example.test/start?tab=one#initial";
const prefix = "https://bb.example.test/preview/synthetic-capability";

describe.each([false, true])("preview history (opaque fallback: %s)", (opaque) => {
  it("restores virtual URL and app state before Back/Forward listeners without exposing its envelope", async () => {
    const dom = new JSDOM('<!doctype html><base href="' + target + '">', {
      url: prefix + "/start?tab=one#initial", runScripts: "outside-only",
    });
    const { window } = dom;
    const { history } = window;
    const initial = { route: "initial", __pinpointHistory: "app-owned" };
    history.replaceState(initial, "");
    if (opaque) {
      for (const name of ["pushState", "replaceState"] as const) {
        const native = history[name];
        history[name] = function (state, title, url) {
          if (url !== undefined) throw new window.DOMException("Synthetic opaque origin", "SecurityError");
          return native.call(this, state, title);
        };
      }
    }
    try {
      window.eval(proxyShim(target, prefix));
      const current = () => window.__pinpointTargetUrl().href;
      const navigate = (direction: "back" | "forward") => {
        const done = Promise.withResolvers<{ url: string; state: unknown; base: string }>();
        window.addEventListener("popstate", (event) => done.resolve({ url: current(), state: event.state, base: window.document.querySelector("base")!.href }), { once: true });
        history[direction]();
        return done.promise;
      };
      expect(history.state).toEqual(initial);
      history.pushState({ route: "spa" }, "", "/spa?tab=two#second");
      expect(current()).toBe("https://preview.example.test/spa?tab=two#second");
      expect(history.state).toEqual({ route: "spa" });
      history.replaceState(7, "", "/spa?tab=three#replaced");
      expect(history.state).toBe(7);
      history.pushState(null, "", "/details?sort=desc");
      expect(history.state).toBeNull();
      expect(await navigate("back")).toEqual({ url: "https://preview.example.test/spa?tab=three#replaced", base: "https://preview.example.test/spa?tab=three#replaced", state: 7 });
      expect(history.state).toBe(7);
      expect(await navigate("back")).toEqual({ url: target, base: target, state: initial });
      expect(await navigate("forward")).toEqual({ url: "https://preview.example.test/spa?tab=three#replaced", base: "https://preview.example.test/spa?tab=three#replaced", state: 7 });
      const length = history.length;
      expect(() => history.pushState({ route: "escape" }, "", "https://outside.example.test/")).toThrow();
      expect(history.length).toBe(length);
      expect(current()).toBe("https://preview.example.test/spa?tab=three#replaced");
      expect(history.state).toBe(7);
    } finally { window.close(); }
  });
});
