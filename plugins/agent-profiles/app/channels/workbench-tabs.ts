import type { PluginFixedTabRegistration } from "@get-bb/plugin-sdk/app";
import { deferred } from "../shared/lazy";

const workbench = () => import("./channel-workbench");

export const channelWorkbenchTabs: PluginFixedTabRegistration[] = [
  {
    id: "activity",
    panelId: "channels",
    title: "Activity",
    icon: "ListView",
    layout: "flush",
    component: deferred(() => workbench().then((module) => module.ChannelActivityTab)),
  },
  {
    id: "output",
    panelId: "channels",
    title: "Output",
    icon: "Paperclip",
    layout: "flush",
    component: deferred(() => workbench().then((module) => module.ChannelOutputTab)),
  },
  {
    id: "decisions",
    panelId: "channels",
    title: "Decisions",
    icon: "CircleCheck",
    layout: "flush",
    component: deferred(() => workbench().then((module) => module.ChannelDecisionsTab)),
  },
  {
    id: "automations",
    panelId: "channels",
    title: "Automations",
    icon: "TimeSchedule",
    layout: "flush",
    component: deferred(() => workbench().then((module) => module.ChannelAutomationsTab)),
  },
  {
    id: "usage",
    panelId: "channels",
    title: "Usage and limits",
    icon: "ChartColumn",
    layout: "flush",
    component: deferred(() => workbench().then((module) => module.ChannelUsageTab)),
  },
];
