// bb-plugin-pinpoint — frontend entry.
//
// Registers the Pinpoint thread panel. The panel itself lives in ./panel and
// is loaded lazily: `bb plugin build` emits a single app.js (no code
// splitting), so the import() below is inlined, but esbuild still defers
// evaluating the panel module (its schemas, icons, and UI) until Pinpoint is
// first opened instead of on every app start.
import { lazy, Suspense } from "react";
import {
  definePluginApp,
  useBbNavigate,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import * as sessions from "./lib/session-registry";
import { IntegrationSettings, MoreSettings, SetupPage } from "./settings";

const LazyPinpointPanel = lazy(() =>
  import("./panel").then((module) => ({ default: module.PinpointPanel })),
);

function PinpointPanelEntry(props: PluginThreadPanelProps) {
  const navigate = useBbNavigate();
  return (
    <Suspense fallback={null}>
      <LazyPinpointPanel {...props} onOpenSetup={() => navigate.toPluginPanel("pinpoint")} />
    </Suspense>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "more", component: MoreSettings });
  app.slots.settingsSection({ id: "oh-my-bb", component: IntegrationSettings });
  app.slots.navPanel({
    id: "pinpoint", title: "Pinpoint", icon: "pinpoint/target",
    path: "pinpoint", component: SetupPage,
  });
  app.contentScripts.register({
    id: "browser-session-lifecycle",
    mount() {
      return () => sessions.disposeAll();
    },
  });
  app.slots.threadPanelAction({
    id: "browser",
    title: "Open Pinpoint",
    icon: "pinpoint/target",
    layout: "flush",
    component: PinpointPanelEntry,
    run(context) {
      context.openPanel({ title: "Pinpoint" });
    },
  });
});
