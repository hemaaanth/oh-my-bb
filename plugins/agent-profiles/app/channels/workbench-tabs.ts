import type { ExperimentalTabRegistration, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { deferred } from "../shared/lazy";

const workbench = () => import("./channel-workbench");

export const channelWorkbenchTabs: ExperimentalTabRegistration[] = [
  {
    id: "activity",
    context: { kind: "nav-panel", panelId: "channels" },
    availability: "fixed",
    title: "Activity",
    icon: "ListView",
    layout: "flush",
    component: deferred<PluginNavPanelProps>(() => workbench().then((module) => module.ChannelActivityTab)),
  },
  {
    id: "output",
    context: { kind: "nav-panel", panelId: "channels" },
    availability: "fixed",
    title: "Output",
    icon: "Paperclip",
    layout: "flush",
    component: deferred<PluginNavPanelProps>(() => workbench().then((module) => module.ChannelOutputTab)),
  },
  {
    id: "decisions",
    context: { kind: "nav-panel", panelId: "channels" },
    availability: "fixed",
    title: "Decisions",
    icon: "CircleCheck",
    layout: "flush",
    component: deferred<PluginNavPanelProps>(() => workbench().then((module) => module.ChannelDecisionsTab)),
  },
  {
    id: "automations",
    context: { kind: "nav-panel", panelId: "channels" },
    availability: "fixed",
    title: "Automations",
    icon: "TimeSchedule",
    layout: "flush",
    component: deferred<PluginNavPanelProps>(() => workbench().then((module) => module.ChannelAutomationsTab)),
  },
  {
    id: "usage",
    context: { kind: "nav-panel", panelId: "channels" },
    availability: "fixed",
    title: "Usage and limits",
    icon: "ChartColumn",
    layout: "flush",
    component: deferred<PluginNavPanelProps>(() => workbench().then((module) => module.ChannelUsageTab)),
  },
];
