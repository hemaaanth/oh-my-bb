import { createRoot, type Root } from "react-dom/client";
import { PinpointPanel } from "./panel";
import {
  configurePublicPinpoint,
  publishPublicPinpointState,
  type PublicConfig,
} from "./public-sdk";

interface PublicMountConfig extends PublicConfig {
  root: HTMLElement;
}

let reactRoot: Root | null = null;
let mounted = false;

function mount(config: PublicMountConfig): void {
  try {
    configurePublicPinpoint(config);
  } catch {
    unmount();
    const message = document.createElement("p");
    message.textContent = "This review server needs the Pinpoint isolated-preview update. Open Pinpoint in BB, or update the review server before using this link.";
    config.root.replaceChildren(message);
    return;
  }
  config.root.setAttribute("data-bb-plugin", "pinpoint");
  if (!reactRoot) {
    config.root.replaceChildren();
    reactRoot = createRoot(config.root);
  }
  if (!mounted) {
    mounted = true;
    reactRoot.render(
      <PinpointPanel
        threadId={config.threadId}
        showBrowserChrome={false}
        reviewPermissions={config.permissions}
        params={{ url: config.target }}
      />,
    );
  }
}
function unmount(): void {
  reactRoot?.unmount();
  reactRoot = null;
  mounted = false;
}

Object.assign(window, {
  PinpointPublicReview: {
    mount,
    updateState: publishPublicPinpointState,
    unmount,
  },
});
