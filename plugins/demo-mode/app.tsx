import { createNativeInfoMask } from "./native-info";
import { useEffect } from "react";
import { createImageMask, imageOptions } from "./images";
import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";
import { applyMode, createLabelMask, createTextMask, CHANGE, enabled, isPluginPage, MODE_KEY, setEnabled } from "./state";
import "./app.css";

const REGIONS = "[data-sidebar=content], [data-sidebar=inset] header, [data-pane-header-focus-tab], [data-timeline-row-id], [data-message-column], [data-promptbox-shell], [class~=animate-shine], [class~='group/timeline-row'], [aria-label=Workflow], [aria-label='Queued messages'], [data-bb-demo-sensitive], [data-bb-demo-label], aside [data-bb-plugin=core] dl";

const toggle = () => setEnabled(MODE_KEY, !enabled(MODE_KEY));

function ImageMask() {
  const { values } = useSettings();
  const { style, pixelSize } = imageOptions(values);
  useEffect(() => createImageMask({ style, pixelSize }), [style, pixelSize]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "image-mask", component: ImageMask });
  app.experimental_sidebarFooter.register({ kind: "action", id: "toggle", label: "Demo Mode", icon: "Eye", onActivate: toggle });
  app.commands.register({ id: "toggle", title: "Toggle Demo Mode", defaultShortcut: { key: "d", mod: true, shift: true }, run: toggle });
  app.contentScripts.register({
    id: "mask",
    mount({ signal }) {
      const nativeInfo = createNativeInfoMask();
      const labels = createLabelMask();
      const content = createTextMask();
      // Labels run first: they tag the footer identifiers that the text mask covers.
      const update = () => { applyMode(); nativeInfo.refresh(enabled(MODE_KEY)); labels.refresh(); content.refresh(); };
      update();
      window.addEventListener(CHANGE, update, { signal });
      window.addEventListener("storage", update, { signal });
      // Navigation inside BB does not reload the page.
      const observer = new MutationObserver((changes) => {
        const pluginPage = enabled(MODE_KEY) && isPluginPage();
        if (document.body.hasAttribute("data-bb-demo-plugin-page") !== pluginPage) applyMode();
        if (enabled(MODE_KEY) && changes.some(({ target, addedNodes, removedNodes }) =>
          (target instanceof Element ? target : target.parentElement)?.closest(REGIONS) ||
          [...addedNodes, ...removedNodes].some((node) => node instanceof Element && (node.matches(REGIONS) || node.querySelector(REGIONS)))
        )) { nativeInfo.refresh(true); labels.refresh(); content.refresh(); }
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["title", "aria-label"] });
      return () => {
        observer.disconnect();
        content.restore();
        labels.restore();
        nativeInfo.restore();
        document.body.removeAttribute("data-bb-demo-mode");
        document.body.removeAttribute("data-bb-demo-plugin-page");
      };
    },
  });
});
