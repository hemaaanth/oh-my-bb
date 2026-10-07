// The frame bridge: the page side of the postMessage link between a BB preview and the BB app
// (protocol in contract.ts FRAME_MESSAGE, host side in app/bridge.ts). injectPage adds it only to
// BB previews, never to published or shared sites. Like the page runtime, it is a plain string.
import { FRAME_MESSAGE } from "../contract.js";

export const FRAME_BRIDGE = String.raw`(() => {
  "use strict";
  if (window.parent === window) return;
  const root = document.documentElement;
  const post = (message) => window.parent.postMessage(message, "*");

  // ---- Theme: later app theme changes arrive here, so the frame never reloads --
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window.parent || !data || data.type !== ${JSON.stringify(FRAME_MESSAGE.theme)}) return;
    if (data.theme === "light" || data.theme === "dark") root.setAttribute("data-bb-theme", data.theme);
  });

  // ---- Links: the sandbox cannot open windows, so the host opens http(s) links --
  // Bubble phase, so a page that handles its own clicks (preventDefault) keeps them. In-page links stay here.
  // A link to another page of a folder (the sibling /v or /a route) goes to the host too: the host sets
  // the frame src, so the request carries the BB session. The frame's own navigation would not.
  const routes = location.pathname.replace(/[^/]*$/u, "");
  window.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.composedPath().find((node) => node instanceof Element && node.matches("a[href]"));
    if (!link) return;
    let url;
    try { url = new URL(link.getAttribute("href"), document.baseURI); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.href.split("#")[0] === location.href.split("#")[0]) return;
    event.preventDefault();
    const page = url.origin === location.origin && (url.pathname === routes + "v" || url.pathname === routes + "a");
    post({ type: page ? ${JSON.stringify(FRAME_MESSAGE.page)} : ${JSON.stringify(FRAME_MESSAGE.open)}, url: url.href });
  });

  // ---- Height: an inline frame fits its page, so the page reports its content height --
  if (root.getAttribute("data-bb-frame") !== "inline" || typeof ResizeObserver !== "function") return;
  let last = -1;
  const report = () => {
    // Taller than the frame: the scroll height. Shorter: the root's own box, which the viewport does not stretch.
    const height = Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    post({ type: ${JSON.stringify(FRAME_MESSAGE.height)}, height });
  };
  const observer = new ResizeObserver(report);
  observer.observe(root);
  const ready = () => { if (document.body) observer.observe(document.body); report(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
  window.addEventListener("load", report);
})();`;
