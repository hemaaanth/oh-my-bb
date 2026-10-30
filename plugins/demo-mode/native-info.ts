// The native Info tab shares these rows across parent/child threads, automations and files.
// Mask values and row names, not the section or the row's status/time columns.
export function createNativeInfoMask() {
  const marked = new Set<Element>();
  const restore = () => { for (const node of marked) node.removeAttribute("data-bb-demo-native"); marked.clear(); };
  const refresh = (active: boolean) => {
    if (!active) { restore(); return; }
    const next = new Set<Element>();
    for (const panel of document.querySelectorAll('aside [data-bb-plugin="core"] dl')) {
      for (const row of panel.querySelectorAll('div:has(> dt):has(> dd)')) {
        if (row.closest("[data-bb-plugin]")?.getAttribute("data-bb-plugin") !== "core") continue;
        const label = row.querySelector(":scope > dt")?.textContent?.trim();
        const value = row.querySelector(":scope > dd")!;
        const text = value.textContent?.trim() ?? "";
        if (["Project", "Machine", "Directory", "Branch"].includes(label ?? "") ||
          label === "Parent" && text !== "None" ||
          label === "Environment" && !["Project checkout", "Worktree", "Sandbox", "Local machine", "None"].includes(text)) next.add(value);
      }
      for (const section of panel.querySelectorAll("[data-info-section]")) {
        for (const name of section.querySelectorAll("li > .flex-1")) {
          // Attachments is the built-in storage folder, not a user-supplied name.
          if (!name.querySelector(":scope > :is(button, a)")) continue;
          const button = name.querySelector(":scope > button");
          if (button?.textContent?.trim() === "Attachments" && button.hasAttribute("aria-expanded")) continue;
          next.add(name);
        }
      }
    }
    for (const node of marked) if (!next.has(node)) node.removeAttribute("data-bb-demo-native");
    marked.clear();
    for (const node of next) { node.setAttribute("data-bb-demo-native", ""); marked.add(node); }
  };
  return { refresh, restore };
}
