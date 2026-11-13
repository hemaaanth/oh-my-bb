// One-line tables, like a spreadsheet. Each cell shows one line. A cell that does not fit
// ends in an ellipsis; a tap or Enter shows the whole value in a panel pinned over the cell.
// The page runtime ships these functions as text (Function#toString), so each one must stand
// alone: no imports, no calls to the others, no helpers from the bundler.

/**
 * Column widths for a one-line table, or null when every column fits at its natural width.
 * Short columns keep their natural width. Long columns share the rest equally. No column gets
 * narrower than its heading or `floor`, so a table on a narrow screen scrolls sideways instead.
 */
export function fitColumns(natural: number[], header: number[], available: number, floor: number): number[] | null {
  let total = 0;
  for (const width of natural) total += width;
  if (total <= available) return null;
  const least = natural.map((width, i) => Math.min(width, Math.max(header[i] || 0, floor)));
  const capped = (cap: number) => natural.map((width, i) => Math.max(least[i]!, Math.min(width, cap)));
  const sum = (widths: number[]) => widths.reduce((a, b) => a + b, 0);
  let low = 0;
  let high = Math.max(...natural);
  if (sum(capped(low)) >= available) return capped(low).map(Math.ceil);
  for (let step = 0; step < 32; step++) {
    const mid = (low + high) / 2;
    if (sum(capped(mid)) > available) high = mid; else low = mid;
  }
  // Round whole columns up so they never clip by a fraction; take the extra from the widest clipped one.
  const widths = capped(low).map((width, i) => (width >= natural[i]! ? Math.ceil(width) : Math.floor(width)));
  const over = sum(widths) - Math.floor(available);
  if (over > 0) {
    let widest = -1;
    widths.forEach((width, i) => { if (width < natural[i]! && (widest < 0 || width > widths[widest]!)) widest = i; });
    if (widest >= 0) widths[widest] = Math.max(Math.ceil(least[widest]!), widths[widest]! - over);
  }
  return widths;
}

/**
 * Lay out one table: measure its columns on one line, then fix their widths to the space its
 * parent gives it. Marks cells that do not fit with data-clipped. Tables with merged cells
 * keep normal wrapping. Pass force after the rows change; otherwise an unchanged width is a no-op.
 */
export function fitTable(table: HTMLTableElement, fit: (natural: number[], header: number[], available: number, floor: number) => number[] | null, force?: boolean): void {
  const box = table.parentElement;
  const view = table.ownerDocument.defaultView;
  const available = box ? box.clientWidth : 0;
  if (!view || !available) return;
  if (!force && table.getAttribute("data-fit-width") === String(available)) return;
  const rows = Array.from(table.rows);
  const head = rows[0];
  const count = head ? head.cells.length : 0;
  const merged = rows.some((row) => row.cells.length !== count || Array.from(row.cells).some((cell) => cell.colSpan > 1 || cell.rowSpan > 1));
  const cells = head ? Array.from(head.cells) : [];
  if (!count || merged) {
    table.removeAttribute("data-fit");
    table.removeAttribute("data-fit-width");
    table.style.tableLayout = "";
    table.style.width = "";
    for (const cell of cells) cell.style.width = "";
    return;
  }
  table.setAttribute("data-fit", "measure");
  table.style.tableLayout = "auto";
  table.style.width = "max-content";
  for (const cell of cells) cell.style.width = "";
  const natural = cells.map((cell) => cell.getBoundingClientRect().width);
  const range = table.ownerDocument.createRange();
  const titled = Boolean(table.tHead && table.tHead.rows[0] === head);
  const header = cells.map((cell) => {
    if (!titled) return 0;
    range.selectNodeContents(cell);
    const style = view.getComputedStyle(cell);
    return Math.ceil(range.getBoundingClientRect().width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight));
  });
  const rem = parseFloat(view.getComputedStyle(table.ownerDocument.documentElement).fontSize) || 16;
  const widths = fit(natural, header, available, 10 * rem);
  table.setAttribute("data-fit-width", String(available));
  if (widths) {
    table.setAttribute("data-fit", "fixed");
    table.style.tableLayout = "fixed";
    table.style.width = widths.reduce((a, b) => a + b, 0) + "px";
    cells.forEach((cell, i) => { cell.style.width = widths[i] + "px"; });
  } else {
    table.setAttribute("data-fit", "auto");
    table.style.tableLayout = "";
    table.style.width = "";
  }
  for (const row of rows.slice(titled ? 1 : 0, 2000)) {
    for (const cell of Array.from(row.cells)) {
      const clipped = cell.scrollWidth > cell.clientWidth + 1;
      if (clipped && !cell.hasAttribute("data-clipped")) { cell.setAttribute("data-clipped", ""); cell.tabIndex = 0; }
      if (!clipped && cell.hasAttribute("data-clipped")) { cell.removeAttribute("data-clipped"); cell.removeAttribute("tabindex"); }
    }
  }
}

/**
 * Click and keydown handler for a fitted table. Opens a clipped cell as a panel that floats over
 * the table, pinned to the cell: the first line stays where it was and nothing below it moves.
 * It follows the cell on scroll. A second tap, a tap elsewhere, Escape, or a resize closes it.
 */
export function toggleCell(event: Event): void {
  type Panel = HTMLElement & { bbClose?: () => void };
  const target = event.target as Element | null;
  if (!target || typeof target.closest !== "function") return;
  const cell = target.closest("td[data-clipped], th[data-clipped]") as HTMLElement | null;
  if (!cell) return;
  if (event.type === "keydown") {
    const key = (event as KeyboardEvent).key;
    if (target !== cell || (key !== "Enter" && key !== " ")) return;
    event.preventDefault();
  } else {
    if (target.closest("a, button, input, select, textarea, summary, label, [contenteditable]")) return;
    const selection = cell.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed && cell.contains(selection.anchorNode)) return;
  }
  const doc = cell.ownerDocument;
  const view = doc.defaultView;
  const box = cell.closest("table")?.parentElement;
  if (!view || !box) return;
  // A tap on the open cell closes the panel on pointerdown; its click must not reopen it.
  const wasOpen = cell.hasAttribute("data-open") || Date.now() - Number(cell.getAttribute("data-closed") || 0) < 500;
  const old = doc.querySelector("[data-cell-panel]") as Panel | null;
  if (old && old.bbClose) old.bbClose();
  if (wasOpen) return;

  const style = view.getComputedStyle(cell);
  let paint = "";
  for (let node: Element | null = cell; node && !paint; node = node.parentElement) {
    const color = view.getComputedStyle(node).backgroundColor;
    if (color && color !== "transparent" && !/,\s*0\)$/.test(color)) paint = color;
  }
  const px = (value: string) => parseFloat(value) || 0;
  const padLeft = px(style.paddingLeft);
  const padTop = px(style.paddingTop);
  const inset = Math.max(padLeft, 8);
  const shift = inset - padLeft + 1;
  const rem = px(view.getComputedStyle(doc.documentElement).fontSize) || 16;
  const panel = doc.createElement("div") as Panel;
  panel.setAttribute("data-cell-panel", "");
  for (const node of Array.from(cell.childNodes)) panel.append(node.cloneNode(true));
  Object.assign(panel.style, {
    position: "fixed", inset: "auto", margin: "0", zIndex: "50", boxSizing: "border-box", width: "max-content",
    maxHeight: "calc(100vh - 16px)", overflow: "auto",
    padding: padTop + "px " + Math.max(px(style.paddingRight), 8) + "px " + px(style.paddingBottom) + "px " + inset + "px",
    background: paint || "Canvas", color: style.color, border: "1px solid " + style.borderBottomColor, borderRadius: "6px",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.22), 0 1px 3px rgba(0, 0, 0, 0.12)",
    fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
    lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, textAlign: style.textAlign,
    fontVariationSettings: style.fontVariationSettings, fontFeatureSettings: style.fontFeatureSettings,
    whiteSpace: "normal", overflowWrap: "anywhere", cursor: "auto",
  });

  const onDown = (down: Event) => {
    if (panel.contains(down.target as Node)) return;
    if (cell.contains(down.target as Node)) cell.setAttribute("data-closed", String(Date.now()));
    close();
  };
  const onKey = (key: KeyboardEvent) => {
    if (key.key !== "Escape") return;
    close();
    cell.focus();
  };
  // Pin the text to the cell's own text and grow down. The panel always stays inside the
  // window: a cell cut off by the window or a sideways-scrolled table moves the panel in.
  const place = () => {
    const rect = cell.getBoundingClientRect();
    const right = doc.documentElement.clientWidth || view.innerWidth;
    const bottom = doc.documentElement.clientHeight || view.innerHeight;
    const widest = Math.max(0, right - 16);
    const least = Math.min(rect.width + shift + 1, widest);
    let left = Math.min(Math.max(8, rect.left - shift), right - 8 - least);
    panel.style.minWidth = least + "px";
    panel.style.maxWidth = Math.min(widest, Math.max(least, Math.min(28 * rem, right - 8 - left))) + "px";
    panel.style.left = left + "px";
    panel.style.top = rect.top - 1 + "px";
    const placed = panel.getBoundingClientRect();
    if (left + placed.width > right - 8) left = Math.max(8, right - 8 - placed.width);
    panel.style.left = left + "px";
    if (rect.top - 1 + placed.height > bottom - 8) panel.style.top = Math.max(8, bottom - 8 - placed.height) + "px";
  };

  const onScroll = (scroll: Event) => { if (!panel.contains(scroll.target as Node)) place(); };
  const onResize = () => close();
  const close = () => {
    if (!panel.isConnected) return;
    panel.remove();
    cell.removeAttribute("data-open");
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("keydown", onKey, true);
    view.removeEventListener("scroll", onScroll, true);
    view.removeEventListener("resize", onResize);
  };
  panel.bbClose = close;
  box.append(panel);
  // The top layer keeps the panel above everything and outside the scroll box's clipping.
  if (typeof panel.showPopover === "function") { panel.popover = "manual"; panel.showPopover(); }
  place();
  cell.setAttribute("data-open", "");
  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("keydown", onKey, true);
  view.addEventListener("scroll", onScroll, true);
  view.addEventListener("resize", onResize);
}
