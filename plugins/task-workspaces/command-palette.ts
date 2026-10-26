import type { PluginCommandRegistration } from "@get-bb/plugin-sdk/app";

export function taskCommandPaletteActions(target: Pick<Window, "dispatchEvent"> & { history: Pick<History, "pushState"> } = window): PluginCommandRegistration[] {
  return [{
    id: "open-tasks",
    title: "Open tasks",
    run() {
      target.history.pushState({}, "", "/plugins/task-workspaces/tasks");
      target.dispatchEvent(new Event("popstate"));
    },
  }];
}
