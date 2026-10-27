import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ProjectRouterBanner } from "./project-router-ui";
import { PreferencesSettings } from "./settings";
import {
  ProjectsSettings,
  GroupsSettings,
  MoreSettings,
} from "./project-settings";
import { registerScriptsApp } from "./scripts-runtime/app";
export default definePluginApp((app) => {
  app.composer.customize({
    id: "jev-project-router",
    scopes: ["new-thread"],
    banners: [
      {
        id: "project-suggestion",
        chrome: "bare",
        component: ProjectRouterBanner,
      },
    ],
  });
  app.slots.settingsSection({
    id: "preferences",
    component: PreferencesSettings,
  });
  app.slots.settingsSection({ id: "groups", component: GroupsSettings });
  app.slots.settingsSection({ id: "projects", component: ProjectsSettings });
  app.slots.settingsSection({ id: "more", component: MoreSettings });
  registerScriptsApp(app);
});
