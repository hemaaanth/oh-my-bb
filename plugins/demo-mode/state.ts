export const MODE_KEY = "bb.demo-mode.enabled";
export const CHANGE = "bb-demo-mode-change";
const volatile = new Map<string, boolean>();

export function enabled(key: string): boolean {
  try { return localStorage.getItem(key) === "true"; } catch { return volatile.get(key) ?? false; }
}

export function setEnabled(key: string, value: boolean): void {
  volatile.set(key, value);
  try { localStorage.setItem(key, String(value)); } catch { /* Keep the choice for this window. */ }
  window.dispatchEvent(new Event(CHANGE));
}

export const isPluginPage = () => /^\/plugins\/[^/]+\/[^/]+/.test(location.pathname);

export function applyMode(root: HTMLElement = document.body): void {
  root.toggleAttribute("data-bb-demo-mode", enabled(MODE_KEY));
  root.toggleAttribute("data-bb-demo-plugin-page", enabled(MODE_KEY) && isPluginPage());
}

const LABELS = [
  '[data-bb-plugin="status-sidebar"] li > div > a[aria-label]',
  '[data-bb-plugin="status-sidebar"] li > div > a + span > span[title]',
  '[data-bb-plugin="status-sidebar"] li > div > a + span button[aria-label]',
  '[data-bb-plugin="status-sidebar"] section[data-reorder-project-id][aria-label]',
  '[data-bb-plugin="status-sidebar"] section[aria-label$="section"]',
  '[data-sidebar-thread-id][aria-label]',
  '[data-sidebar="content"] .bb-thread-title[title]',
  '[data-sidebar="inset"] header .bb-thread-title[title]',
  '[data-pane-header-focus-tab] .bb-thread-title[title]',
  '[data-sidebar-sticky-project-item] [data-sidebar-sticky-tier="label"] [title]',
  '[data-sidebar-sticky-project-item] [data-sidebar-sticky-tier="label"] button[aria-label]',
  '[data-promptbox-shell] [data-option-display][title^="Project:"]',
  '[data-promptbox-shell] [data-option-display][title^="Environment:"]',
  '[data-promptbox-shell] button[aria-label^="Thread details:"]',
  '[data-promptbox-project-control][aria-label]',
  '[data-promptbox-shell] [data-promptbox-hide-branch-compact][title]',
  ':is([data-promptbox], [data-message-column]) button:has(> img)[title]',
  '[data-promptbox] [role="status"][aria-label^="Uploading "]',
  '[data-promptbox] button[aria-label^="Remove "]',
  'button[aria-label$="Open model and machine details"]',
  '[class~="group/timeline-row"] span[title]',
  '[aria-label="Workflow"] #thread-workflow-card-toggle[aria-label]',
  '[aria-label="Workflow"] [title]',
  '[aria-label="Queued messages"] [data-queued-message-row] [title]',
  '#thread-prompt-banner-git-toggle[aria-label]',
  ':is([data-bb-demo-sensitive], [data-bb-demo-sensitive] *):is([title], [aria-label])',
].join(", ");

// Names and content whose words become blocks. Blocks paint over the real text, so layout never moves.
const TEXT = [
  '[data-sidebar="content"] .bb-thread-title',
  '[data-bb-plugin="status-sidebar"] li > div > a + span > span[title]',
  '[data-bb-plugin="status-sidebar"] section[data-reorder-project-id] > div > button > span:nth-child(2)',
  '[data-bb-plugin="status-sidebar"] section[data-bb-demo-identifier] > div > button > span:nth-child(2)',
  '[data-sidebar="content"] [data-sidebar-sticky-project-item] [data-sidebar-sticky-tier="label"] > span > span:first-child',
  '[data-sidebar="content"] [data-project-metadata] > span',
  '[data-sidebar="inset"] header .bb-thread-title',
  '[data-pane-header-focus-tab] .bb-thread-title',
  '[data-bb-demo-identifier] span.truncate',
  '[data-promptbox-project-control] span.truncate',
  '[data-promptbox-hide-branch-compact] > span.truncate',
  '[data-promptbox-shell] [data-option-display][data-bb-demo-identifier] ~ span.inline-flex > span.truncate',
  '[data-promptbox-main] > [data-promptbox-expanded-only] > .mx-3 .truncate',
  '[data-promptbox] [role="status"] .truncate',
  '[data-timeline-row-id]',
  '[data-message-column]',
  '[data-promptbox-editor-content] [contenteditable]',
  // Status line ("Working…"), running command bar, and the uncommitted-files banner sit outside the rows.
  '[class~="animate-shine"]',
  '[class~="group/timeline-row"]',
  '[aria-label="Workflow"] #thread-workflow-card-toggle [title]',
  '[aria-label="Workflow"] #thread-workflow-card-body :is([title], .font-medium)',
  '[aria-label="Queued messages"] [data-queued-message-row] :is([title], [data-queued-message-wait])',
  '[data-promptbox-shell] section[aria-label="Thread context before sending"]',
  // Any plugin can mark its own sensitive elements; see README "For plugin authors".
  '[data-bb-demo-sensitive]',
].join(", ");
export const HIGHLIGHT = "bb-demo";

export function createTextMask() {
  const words = new Map<Text, { data: string; ranges: StaticRange[] }>();
  const highlight = new Highlight();
  const restore = () => {
    CSS.highlights.delete(HIGHLIGHT);
    highlight.clear();
    words.clear();
  };
  const refresh = () => {
    if (!enabled(MODE_KEY)) { restore(); return; }
    CSS.highlights.set(HIGHLIGHT, highlight);
    const seen = new Set<Text>();
    for (const root of document.querySelectorAll(TEXT)) {
      if (root.parentElement?.closest(TEXT)) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        seen.add(text);
        const known = words.get(text);
        if (known?.data === text.data) continue;
        for (const range of known?.ranges ?? []) highlight.delete(range);
        const ranges = [...text.data.matchAll(/\S+/g)].map((match) => new StaticRange({
          startContainer: text, startOffset: match.index, endContainer: text, endOffset: match.index + match[0].length,
        }));
        for (const range of ranges) highlight.add(range);
        words.set(text, { data: text.data, ranges });
      }
    }
    for (const [text, { ranges }] of words) {
      if (seen.has(text)) continue;
      for (const range of ranges) highlight.delete(range);
      words.delete(text);
    }
  };
  return { refresh, restore };
}

export function createLabelMask() {
  const original = new Map<Element, Map<string, string>>();
  const restore = () => {
    for (const [element, attributes] of original) {
      for (const [name, value] of attributes) {
        if (element.getAttribute(name) === "Demo item") element.setAttribute(name, value);
      }
      element.removeAttribute("data-bb-demo-identifier");
    }
    original.clear();
  };
  const refresh = () => {
    if (!enabled(MODE_KEY)) { restore(); return; }
    for (const element of document.querySelectorAll(LABELS)) {
      for (const name of ["title", "aria-label"]) {
        const value = element.getAttribute(name);
        if (value === null || value === "Demo item") continue;
        let attributes = original.get(element);
        if (!attributes) { attributes = new Map(); original.set(element, attributes); }
        attributes.set(name, value);
        if (element.closest("[data-promptbox-shell]") || element.matches('[data-bb-plugin="status-sidebar"] section')) element.setAttribute("data-bb-demo-identifier", "");
        element.setAttribute(name, "Demo item");
      }
    }
  };
  return { refresh, restore };
}
