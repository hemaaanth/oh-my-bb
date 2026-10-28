import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { StatusSidebar } from "./components/StatusSidebar";
import { MoreSettings } from "./components/Setup";
import { IntegrationSettings } from "./components/IntegrationSettings";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "status-sidebar",
    title: "Status Sidebar",
    description:
      "Groups threads by status, with timed snoozing and a recent archive.",
    component: StatusSidebar,
  });
  app.slots.settingsSection({ id: "more", component: MoreSettings });
  app.slots.settingsSection({ id: "oh-my-bb", component: IntegrationSettings });
});
