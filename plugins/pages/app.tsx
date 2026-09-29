import { useState } from "react";
import { definePluginApp, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { registerShareSlots } from "./app/share/SharePopover.js";
import { UUID, relativeFile } from "./app/directives.js";
import { Library, LibraryPanel } from "./app/Library.js";
import { PANEL_ACTION_ID, directiveComponent } from "./app/PageCard.js";
import { LIBRARY_PATH, LiveFileView, PageView } from "./app/PageView.js";

/** Panel params are untrusted: `{ pageId, versionId? }`, `{ threadId, source, file }` for a live file, or none for the library. */
function ThreadPanel({ threadId: panelThreadId, params }: PluginThreadPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const values = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const { pageId, versionId, threadId, source, file } = values;
  if (typeof pageId === "string" && UUID.test(pageId)) {
    return <PageView pageId={pageId.toLowerCase()} versionId={typeof versionId === "string" && UUID.test(versionId) ? versionId.toLowerCase() : null} threadId={panelThreadId} />;
  }
  const liveFile = typeof file === "string" ? relativeFile(file) : null;
  if (liveFile && typeof threadId === "string" && threadId && (source === "workspace" || source === "thread-storage")) {
    return <LiveFileView threadId={threadId} file={liveFile} source={source} />;
  }
  return <Library inPanel selectedId={selected} onSelect={setSelected} />;
}

/**
 * BB renders a directive as literal text when two enabled plugins register the same id.
 * The builtin inline-vis is disabled and the artifacts plugin is uninstalled, so Pages owns
 * both old ids. Do not re-enable either of them while this is true.
 */
export const REGISTER_LEGACY_ALIASES = true;

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "page", component: directiveComponent("page") });
  if (REGISTER_LEGACY_ALIASES) {
    app.slots.messageDirective({ id: "artifact", component: directiveComponent("artifact") });
    app.slots.messageDirective({ id: "inline-vis", component: directiveComponent("inline-vis") });
  }
  app.slots.threadPanelAction({ id: PANEL_ACTION_ID, title: "Pages", icon: "FileText", layout: "flush", component: ThreadPanel });
  app.slots.navPanel({ id: "pages", title: "Pages", icon: "FileText", path: LIBRARY_PATH, component: LibraryPanel });
  registerShareSlots(app);
});
