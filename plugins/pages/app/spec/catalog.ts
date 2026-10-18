// The spec catalog: every group in gallery and reference order, and the OpenUI library built from it.
import { createLibrary } from "@openuidev/react-lang";
import type { Group } from "./kit.js";
import { group as charts } from "./groups/charts.js";
import { group as content } from "./groups/content.js";
import { group as data } from "./groups/data.js";
import { group as dev } from "./groups/dev.js";
import { group as evidence } from "./groups/evidence.js";
import { group as inputs } from "./groups/inputs.js";
import { group as layout } from "./groups/layout.js";
import { group as manage } from "./groups/manage.js";
import { group as media } from "./groups/media.js";
import { group as project } from "./groups/project.js";
import { group as widgets } from "./groups/widgets.js";

export const GROUPS: Group[] = [layout, content, data, charts, inputs, media, dev, project, manage, evidence, widgets];

export const specLibrary = createLibrary({
  id: "bb-pages",
  root: "Stack",
  components: GROUPS.flatMap((group) => group.entries.map((entry) => entry.component)),
  componentGroups: GROUPS.filter((group) => group.entries.length > 0).map((group) => ({ name: group.name, components: group.entries.map((entry) => entry.component.name), ...(group.notes ? { notes: group.notes } : {}) })),
});
