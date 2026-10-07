// The page runtime: tabs (div.tabs), contents (nav.toc), and image zoom.
// injectPage adds it inline only to pages that use one of them. It is a plain string, not a
// bundled module, so the bytes shipped are exactly the bytes written here.

/** True when the page uses a component the runtime drives. */
export function needsPageRuntime(html: string): boolean {
  return /\bclass\s*=\s*["']?[^"'>]*\b(?:tabs|toc|compare)\b/iu.test(html) || /<img\b[^>]*\bdata-zoom(?:\s|=|>)/iu.test(html);
}

/** True when the page contains the opt-in virtualized data table component. */
export function needsDataTableRuntime(html: string): boolean {
  return /\bclass\s*=\s*["']?[^"'>]*\bdata-table\b/iu.test(html);
}

export const PAGE_RUNTIME = String.raw`(() => {
  "use strict";
  const doc = document;

  // ---- Tabs: div.tabs > section[data-tab] -------------------------------
  const groups = [];
  doc.querySelectorAll(".tabs").forEach((tabs, g) => {
    const panels = Array.from(tabs.children).filter((el) => el.matches("section[data-tab]"));
    if (!panels.length) return;
    const list = doc.createElement("div");
    list.className = "tab-list";
    list.setAttribute("role", "tablist");
    const buttons = panels.map((panel, i) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = panel.dataset.tab;
      button.id = "tab-" + g + "-" + i;
      button.setAttribute("role", "tab");
      if (!panel.id) panel.id = "tabpanel-" + g + "-" + i;
      button.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", button.id);
      button.addEventListener("click", () => select(i, true));
      list.append(button);
      return button;
    });
    const select = (index, focus) => {
      panels.forEach((panel, i) => { panel.hidden = i !== index; });
      buttons.forEach((button, i) => {
        button.setAttribute("aria-selected", String(i === index));
        button.tabIndex = i === index ? 0 : -1;
      });
      if (focus) buttons[index].focus();
      doc.dispatchEvent(new Event("pages:tabchange"));
    };
    list.addEventListener("keydown", (event) => {
      const current = buttons.indexOf(doc.activeElement);
      if (current < 0) return;
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      const next = step ? (current + step + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      select(next, true);
    });
    tabs.prepend(list);
    tabs.setAttribute("data-ready", "");
    const initial = Math.max(0, panels.findIndex((panel) => panel.hasAttribute("data-selected")));
    select(initial, false);
    groups.push({ panels, select });
  });

  /** Open every tab that hides the target, so a link into a tab works. */
  const reveal = (target) => {
    for (const group of groups) {
      const index = group.panels.findIndex((panel) => panel.contains(target));
      if (index >= 0 && group.panels[index].hidden) group.select(index, false);
    }
  };

  // ---- Contents: nav.toc -------------------------------------------------
  const slug = (text) => text.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^\w-]+/g, "") || "section";
  const used = new Set(Array.from(doc.querySelectorAll("[id]"), (el) => el.id));
  doc.querySelectorAll("nav.toc").forEach((nav) => {
    if (!nav.querySelector("a[href^='#']")) {
      const scope = nav.closest(".page") || doc.body;
      const selector = nav.dataset.depth === "3" ? "h2, h3" : "h2";
      const headings = Array.from(scope.querySelectorAll(selector)).filter((h) => !h.closest("nav.toc, figure, .note, details, [data-toc='skip']"));
      if (!headings.length) return;
      const ul = doc.createElement("ul");
      for (const heading of headings) {
        if (!heading.id) {
          let id = slug(heading.textContent), n = 2;
          while (used.has(id)) id = slug(heading.textContent) + "-" + n++;
          used.add(id);
          heading.id = id;
        }
        const li = doc.createElement("li");
        if (heading.tagName === "H3") li.className = "toc-sub";
        const a = doc.createElement("a");
        a.href = "#" + heading.id;
        a.textContent = heading.textContent.trim();
        li.append(a);
        ul.append(li);
      }
      if (!nav.querySelector(".toc-label")) {
        const label = doc.createElement("p");
        label.className = "toc-label";
        label.textContent = nav.getAttribute("aria-label") || "Contents";
        nav.append(label);
      }
      nav.append(ul);
    }
    if (!nav.hasAttribute("aria-label")) nav.setAttribute("aria-label", "Contents");
    const links = Array.from(nav.querySelectorAll("a[href^='#']")).map((a) => ({ a, target: doc.getElementById(decodeURIComponent(a.getAttribute("href").slice(1))) })).filter((link) => link.target);
    for (const { a, target } of links) {
      a.addEventListener("click", (event) => {
        event.preventDefault();
        reveal(target);
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    // The site's rule: the last heading above the top of the view is current;
    // the last heading wins once it is visible near the end of the page.
    const spy = () => {
      const top = window.scrollY + 50;
      let current = null;
      for (const link of links) {
        if (!link.target.offsetParent) continue;
        if (link.target.getBoundingClientRect().top + window.scrollY <= top) current = link;
      }
      const last = links.filter((link) => link.target.offsetParent).pop();
      if (last) {
        const rect = last.target.getBoundingClientRect();
        const roomLeft = doc.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
        if (rect.top >= 0 && rect.top <= window.innerHeight && roomLeft < 300) current = last;
      }
      for (const link of links) {
        const on = link === current;
        link.a.classList.toggle("active", on);
        if (on) link.a.setAttribute("aria-current", "true");
        else link.a.removeAttribute("aria-current");
      }
    };
    let queued = false;
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; spy(); }); } };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    doc.addEventListener("pages:tabchange", schedule);
    spy();
  });

  if (location.hash) {
    const target = doc.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) { reveal(target); target.scrollIntoView(); }
  }

  // ---- Image zoom: explicit img[data-zoom], or downscaled compare images --
  if (!doc.documentElement.hasAttribute("data-bb-frame")) {
    let dialog = null;
    let dialogImage = null;
    let dialogCaption = null;
    const ensureDialog = () => {
      if (dialog) return dialog;
      dialog = doc.createElement("dialog");
      dialog.className = "image-lightbox";
      dialog.setAttribute("aria-label", "Image preview");
      const close = doc.createElement("button");
      close.type = "button";
      close.className = "image-lightbox-close";
      close.setAttribute("aria-label", "Close image preview");
      close.textContent = "×";
      dialogImage = doc.createElement("img");
      dialogCaption = doc.createElement("p");
      dialogCaption.className = "image-lightbox-caption";
      close.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
      dialog.append(close, dialogImage, dialogCaption);
      doc.body.append(dialog);
      return dialog;
    };
    const openImage = (image) => {
      const modal = ensureDialog();
      dialogImage.src = image.currentSrc || image.src;
      dialogImage.alt = image.alt || "";
      const figureCaption = image.closest("figure")?.querySelector("figcaption")?.textContent?.trim();
      const compareLabel = image.closest(".compare > *")?.querySelector(".compare-label")?.textContent?.trim();
      dialogCaption.textContent = figureCaption || compareLabel || image.alt || "";
      dialogCaption.hidden = !dialogCaption.textContent;
      modal.showModal();
    };
    const enable = (image) => {
      if (image.hasAttribute("data-pages-zoom-ready") || image.closest("a, button")) return;
      image.setAttribute("data-pages-zoom-ready", "");
      image.setAttribute("role", "button");
      image.tabIndex = 0;
      image.setAttribute("aria-label", (image.alt ? image.alt + ". " : "") + "Open full-size image");
      image.addEventListener("click", () => openImage(image));
      image.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openImage(image);
      });
    };
    const assess = (image) => {
      if (image.hasAttribute("data-zoom")) return enable(image);
      if (!image.closest(".compare") || !image.naturalWidth || !image.clientWidth) return;
      if (image.naturalWidth > image.clientWidth * 1.15 || image.naturalHeight > image.clientHeight * 1.15) enable(image);
    };
    doc.querySelectorAll("img[data-zoom], .compare img").forEach((image) => {
      if (image.hasAttribute("data-zoom") || image.complete) assess(image);
      else image.addEventListener("load", () => assess(image), { once: true });
    });
  }
})();`;

// Data tables use JSON rather than thousands of <tr> elements. Only the rows
// in view become DOM nodes, so sorting 10,000 rows does not make scrolling pay
// for 10,000 rendered elements.
export const DATA_TABLE_RUNTIME = String.raw`(() => {
  "use strict";
  const doc = document;
  const ROW_HEIGHT = 40;
  const HEADER_HEIGHT = 40;
  const OVERSCAN = 6;
  const TYPES = new Set(["text", "email", "pill", "currency", "percent"]);
  const TONES = new Set(["neutral", "info", "success", "warning", "danger"]);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const text = (value) => value == null ? "" : typeof value === "object" ? String(value.label ?? value.value ?? "") : String(value);
  const number = (value) => {
    if (value == null || value === "") return null;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const safeHref = (value) => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return null;
    try {
      const url = new URL(value, location.href);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch { return null; }
  };
  const fail = (root, message) => {
    root.replaceChildren();
    const error = doc.createElement("p");
    error.className = "data-table-error";
    error.textContent = "This data table could not be drawn: " + message;
    root.append(error);
  };
  let menuNumber = 0;
  const makeSelect = (options, selected, label, onChange) => {
    const wrap = doc.createElement("span");
    wrap.className = "data-table-select";
    const trigger = doc.createElement("button");
    trigger.type = "button";
    trigger.className = "data-table-select-trigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-label", label);
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const valueLabel = doc.createElement("span");
    const menu = doc.createElement("span");
    menu.className = "data-table-select-menu";
    menu.id = "data-table-menu-" + ++menuNumber;
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    trigger.setAttribute("aria-controls", menu.id);
    trigger.append(valueLabel);
    wrap.append(trigger);
    doc.body.append(menu);
    let value = options.some((option) => option[0] === selected) ? selected : options[0][0];
    const close = (focus) => {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (focus) trigger.focus();
    };
    const choose = (next, notify) => {
      value = next;
      const current = options.find((option) => option[0] === value) || options[0];
      valueLabel.textContent = current[1];
      Array.from(menu.children).forEach((option) => option.setAttribute("aria-selected", String(option.dataset.value === value)));
      close(false);
      if (notify) onChange(value);
    };
    const open = () => {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      const rect = trigger.getBoundingClientRect();
      menu.style.width = rect.width + "px";
      menu.style.left = rect.left + "px";
      menu.style.top = rect.bottom + 4 + "px";
      menu.style.bottom = "auto";
      const menuHeight = menu.getBoundingClientRect().height;
      if (window.innerHeight - rect.bottom < menuHeight + 8 && rect.top > window.innerHeight - rect.bottom) {
        menu.style.top = "auto";
        menu.style.bottom = window.innerHeight - rect.top + 4 + "px";
      }
      (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild)?.focus();
    };
    for (const [optionValue, optionLabel] of options) {
      const option = doc.createElement("button");
      option.type = "button";
      option.className = "data-table-select-option";
      option.dataset.value = optionValue;
      option.setAttribute("role", "option");
      option.textContent = optionLabel;
      option.addEventListener("click", () => choose(optionValue, true));
      menu.append(option);
    }
    choose(value, false);
    trigger.addEventListener("click", () => menu.hidden ? open() : close(false));
    const onKeydown = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); close(true); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      if (menu.hidden) { open(); return; }
      const items = Array.from(menu.children);
      const current = Math.max(0, items.indexOf(doc.activeElement));
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    };
    wrap.addEventListener("keydown", onKeydown);
    menu.addEventListener("keydown", onKeydown);
    doc.addEventListener("click", (event) => { if (!menu.hidden && !wrap.contains(event.target)) close(false); });
    window.addEventListener("scroll", () => close(false), true);
    window.addEventListener("resize", () => close(false));
    return {
      element: wrap,
      get value() { return value; },
      set value(next) { choose(next, false); },
      get selectedIndex() { return options.findIndex((option) => option[0] === value); },
      set selectedIndex(index) { choose(options[index]?.[0] ?? options[0][0], false); },
      focus: () => trigger.focus(),
      removeAttribute: (name) => trigger.removeAttribute(name),
      setAttribute: (name, next) => trigger.setAttribute(name, next),
    };
  };

  doc.querySelectorAll(".data-table").forEach((root, tableIndex) => {
    if (root.hasAttribute("data-ready")) return;
    const script = Array.from(root.children).find((child) => child.tagName === "SCRIPT" && /^application\/json\b/i.test(child.getAttribute("type") || ""));
    if (!script) { fail(root, "missing JSON data"); return; }
    let data;
    try { data = JSON.parse(script.textContent || ""); }
    catch (error) { fail(root, error instanceof Error ? error.message : String(error)); return; }
    if (!data || !Array.isArray(data.columns) || !data.columns.length || !Array.isArray(data.rows)) { fail(root, "expected columns and rows arrays"); return; }
    const columns = data.columns.map((raw, index) => {
      const column = raw && typeof raw === "object" ? raw : {};
      const type = TYPES.has(column.type) ? column.type : "text";
      const key = typeof column.key === "string" && column.key ? column.key : String(index);
      const width = Number.isFinite(column.width) ? Math.max(80, Math.min(600, column.width)) : ({ pill: 140, currency: 130, percent: 110, email: 220 }[type] || 180);
      const currency = typeof column.currency === "string" && /^[A-Z]{3}$/.test(column.currency) ? column.currency : "USD";
      return { key, label: String(column.label || key), type, width, currency, digits: Number.isInteger(column.digits) ? Math.max(0, Math.min(6, column.digits)) : type === "percent" ? 1 : type === "currency" ? 2 : 0 };
    });
    const rows = data.rows.filter((row) => row && typeof row === "object").map((row, index) => ({ row, index }));
    if (!root.id) root.id = "data-table-" + (tableIndex + 1);
    const queryPrefix = "dt." + root.id + ".";
    const filters = new Map();
    const initialUrl = new URL(location.href);
    for (const column of columns) {
      const raw = initialUrl.searchParams.get(queryPrefix + column.key);
      if (!raw) continue;
      const split = raw.indexOf(":");
      if (split < 1 || split === raw.length - 1) continue;
      const op = raw.slice(0, split);
      const value = raw.slice(split + 1);
      const allowed = column.type === "pill" ? ["eq"] : column.type === "currency" || column.type === "percent" ? ["gt", "lt"] : ["contains", "eq", "regex"];
      if (allowed.includes(op)) filters.set(column.key, { op, value });
    }
    const template = columns.map((column) => "minmax(" + column.width + "px, 1fr)").join(" ");
    const minimum = columns.reduce((sum, column) => sum + column.width, 0);
    const formats = new Map();
    const formatter = (column) => {
      const key = column.type + ":" + column.currency + ":" + column.digits;
      if (!formats.has(key)) formats.set(key, column.type === "currency"
        ? new Intl.NumberFormat(undefined, { style: "currency", currency: column.currency, maximumFractionDigits: column.digits })
        : new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: column.digits }));
      return formats.get(key);
    };

    const status = doc.createElement("div");
    status.className = "data-table-status";
    status.setAttribute("aria-live", "polite");
    const viewport = doc.createElement("div");
    viewport.className = "data-table-viewport scroll";
    viewport.tabIndex = 0;
    const height = Number(root.dataset.height);
    if (Number.isFinite(height)) viewport.style.height = Math.max(240, Math.min(800, height)) + "px";
    const table = doc.createElement("div");
    table.className = "data-table-grid";
    table.setAttribute("role", "table");
    table.setAttribute("aria-rowcount", String(rows.length + 1));
    table.setAttribute("aria-colcount", String(columns.length));
    const label = root.getAttribute("aria-label") || (typeof data.label === "string" ? data.label : "");
    if (label) table.setAttribute("aria-label", label);
    table.style.minWidth = minimum + "px";
    const head = doc.createElement("div");
    head.className = "data-table-head";
    head.setAttribute("role", "row");
    head.style.gridTemplateColumns = template;
    const body = doc.createElement("div");
    body.className = "data-table-body";
    body.setAttribute("role", "rowgroup");
    body.style.height = rows.length * ROW_HEIGHT + "px";
    table.append(head, body);
    viewport.append(table);
    const footer = doc.createElement("div");
    footer.className = "data-table-footer";
    const filterWrap = doc.createElement("div");
    filterWrap.className = "data-table-filter-wrap";
    const filterButton = doc.createElement("button");
    filterButton.type = "button";
    filterButton.className = "data-table-filter-button";
    filterButton.setAttribute("aria-expanded", "false");
    const filterLabel = doc.createElement("span");
    filterLabel.textContent = "Filter";
    const filterCount = doc.createElement("span");
    filterCount.className = "data-table-filter-count";
    filterButton.append(filterLabel, filterCount);
    const panel = doc.createElement("div");
    panel.className = "data-table-filter-panel";
    panel.id = root.id + "-filters";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Filters");
    panel.hidden = true;
    filterButton.setAttribute("aria-controls", panel.id);
    const panelHead = doc.createElement("div");
    panelHead.className = "data-table-filter-panel-head";
    const panelTitle = doc.createElement("span");
    panelTitle.textContent = "Filters";
    const clearButton = doc.createElement("button");
    clearButton.type = "button";
    clearButton.textContent = "Clear";
    panelHead.append(panelTitle, clearButton);
    panel.append(panelHead);
    filterWrap.append(filterButton, panel);
    footer.append(status, filterWrap);
    root.replaceChildren(viewport, footer);
    root.setAttribute("data-ready", "");
    const fillsTab = !root.hasAttribute("data-height") && root.parentElement?.matches("section[data-tab]") && root.parentElement.children.length === 1;
    if (fillsTab) root.classList.add("data-table-fill");

    let filtered = rows;
    let ordered = rows;
    let sortIndex = -1;
    let direction = 1;
    let frame = 0;
    const filterControls = new Map();
    const headings = [];
    const valueFor = (item, column) => item.row[column.key];
    const sortValue = (value, column) => column.type === "currency" || column.type === "percent" ? number(value) : text(value);
    const announce = () => {
      status.textContent = filters.size
        ? filtered.length.toLocaleString() + " of " + rows.length.toLocaleString() + " rows"
        : rows.length.toLocaleString() + (rows.length === 1 ? " row" : " rows");
    };
    const drawCell = (cell, value, column) => {
      cell.className = "data-table-cell" + (column.type === "currency" || column.type === "percent" ? " num" : "");
      cell.setAttribute("role", "cell");
      const numeric = number(value);
      if ((column.type === "currency" || column.type === "percent") && numeric != null) { cell.textContent = formatter(column).format(numeric); return; }
      if (column.type === "email") {
        const email = text(value);
        if (!email) return;
        const link = doc.createElement("a");
        link.href = "mailto:" + email;
        link.textContent = email;
        cell.append(link);
        return;
      }
      if (column.type === "pill") {
        const label = text(value);
        if (!label) return;
        const rawTone = value && typeof value === "object" ? value.tone : "neutral";
        const tone = TONES.has(rawTone) ? rawTone : "neutral";
        const href = value && typeof value === "object" ? safeHref(value.href) : null;
        const pill = doc.createElement(href ? "a" : "span");
        pill.className = "data-table-pill " + tone;
        pill.textContent = label;
        if (href) { pill.href = href; pill.target = "_blank"; pill.rel = "noopener noreferrer"; }
        cell.append(pill);
        return;
      }
      cell.textContent = text(value);
    };
    const render = () => {
      frame = 0;
      const top = Math.max(0, viewport.scrollTop - HEADER_HEIGHT);
      const visible = Math.ceil((viewport.clientHeight || 480) / ROW_HEIGHT);
      const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
      const end = Math.min(ordered.length, start + visible + OVERSCAN * 2);
      body.replaceChildren();
      for (let index = start; index < end; index += 1) {
        const item = ordered[index];
        const row = doc.createElement("div");
        row.className = "data-table-row";
        row.setAttribute("role", "row");
        row.setAttribute("aria-rowindex", String(index + 2));
        row.style.gridTemplateColumns = template;
        row.style.transform = "translateY(" + index * ROW_HEIGHT + "px)";
        for (const column of columns) {
          const cell = doc.createElement("div");
          drawCell(cell, valueFor(item, column), column);
          row.append(cell);
        }
        body.append(row);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    const sortRows = (items) => {
      if (sortIndex < 0) return items.slice();
      const column = columns[sortIndex];
      return items.slice().sort((left, right) => {
        const a = sortValue(valueFor(left, column), column);
        const b = sortValue(valueFor(right, column), column);
        if (a == null || a === "") return b == null || b === "" ? left.index - right.index : 1;
        if (b == null || b === "") return -1;
        const result = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
        return result ? result * direction : left.index - right.index;
      });
    };
    const writeUrl = () => {
      const url = new URL(location.href);
      for (const column of columns) url.searchParams.delete(queryPrefix + column.key);
      for (const [key, filter] of filters) url.searchParams.set(queryPrefix + key, filter.op + ":" + filter.value);
      if (filters.size) url.hash = root.id;
      else if (decodeURIComponent(url.hash.slice(1)) === root.id) url.hash = "";
      try { history.replaceState(null, "", url); } catch { /* opaque preview origin */ }
    };
    const applyFilters = (updateUrl) => {
      const tests = [];
      for (const [key, filter] of filters) {
        const column = columns.find((candidate) => candidate.key === key);
        if (!column) continue;
        const control = filterControls.get(key);
        if (control?.input) control.input.removeAttribute("aria-invalid");
        if (column.type === "currency" || column.type === "percent") {
          let threshold = Number(filter.value);
          if (column.type === "percent") threshold /= 100;
          if (!Number.isFinite(threshold)) {
            if (control?.input) control.input.setAttribute("aria-invalid", "true");
            tests.push(() => false);
          } else tests.push((item) => {
            const value = number(valueFor(item, column));
            return value != null && (filter.op === "gt" ? value > threshold : value < threshold);
          });
        } else if (column.type === "pill") {
          tests.push((item) => collator.compare(text(valueFor(item, column)), filter.value) === 0);
        } else if (filter.op === "regex") {
          let expression;
          try { expression = new RegExp(filter.value, "i"); }
          catch {
            if (control?.input) control.input.setAttribute("aria-invalid", "true");
            tests.push(() => false);
          }
          if (expression) tests.push((item) => expression.test(text(valueFor(item, column))));
        } else {
          const needle = filter.value.toLocaleLowerCase();
          tests.push((item) => {
            const value = text(valueFor(item, column)).toLocaleLowerCase();
            return filter.op === "eq" ? value === needle : value.includes(needle);
          });
        }
      }
      filtered = tests.length ? rows.filter((item) => tests.every((test) => test(item))) : rows;
      ordered = sortRows(filtered);
      body.style.height = ordered.length * ROW_HEIGHT + "px";
      table.setAttribute("aria-rowcount", String(ordered.length + 1));
      headings.forEach((heading, index) => {
        const active = filters.has(columns[index].key);
        heading.classList.toggle("filtered", active);
        const button = heading.querySelector("button");
        if (active) button.setAttribute("aria-label", columns[index].label + ", filtered");
        else button.removeAttribute("aria-label");
      });
      filterCount.textContent = filters.size ? String(filters.size) : "";
      clearButton.disabled = !filters.size;
      viewport.scrollTop = 0;
      announce();
      if (updateUrl) writeUrl();
      render();
    };
    const sort = (index) => {
      direction = sortIndex === index ? -direction : 1;
      sortIndex = index;
      ordered = sortRows(filtered);
      viewport.scrollTop = 0;
      Array.from(head.children).forEach((cell, cellIndex) => cell.setAttribute("aria-sort", cellIndex === index ? (direction > 0 ? "ascending" : "descending") : "none"));
      render();
    };
    columns.forEach((column, index) => {
      const cell = doc.createElement("div");
      cell.className = "data-table-heading" + (column.type === "currency" || column.type === "percent" ? " num" : "");
      cell.setAttribute("role", "columnheader");
      cell.setAttribute("aria-sort", "none");
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = column.label;
      button.addEventListener("click", () => sort(index));
      cell.append(button);
      head.append(cell);
      headings.push(cell);

      const filterRow = doc.createElement("div");
      filterRow.className = "data-table-filter-row";
      filterRow.dataset.column = column.key;
      const rowLabel = doc.createElement("span");
      rowLabel.textContent = column.label;
      filterRow.append(rowLabel);
      const saved = filters.get(column.key);
      if (column.type === "pill") {
        const values = Array.from(new Set(rows.map((item) => text(valueFor(item, column))).filter(Boolean))).sort(collator.compare);
        const select = makeSelect([["", "Any status"], ...values.map((value) => [value, value])], saved?.value || "", column.label + " filter", (value) => {
          if (value) filters.set(column.key, { op: "eq", value });
          else filters.delete(column.key);
          applyFilters(true);
        });
        filterControls.set(column.key, { input: select });
        filterRow.append(select.element);
      } else {
        const controls = doc.createElement("span");
        controls.className = "data-table-filter-controls";
        const modes = column.type === "currency" || column.type === "percent"
          ? [["gt", "Above"], ["lt", "Below"]]
          : [["contains", "Partial"], ["eq", "Exact"], ["regex", "Regex"]];
        let update = () => {};
        const mode = makeSelect(modes, saved?.op || modes[0][0], column.label + " match type", () => update());
        const input = doc.createElement("input");
        input.setAttribute("aria-label", column.label + " filter value");
        input.type = "text";
        if (column.type === "currency" || column.type === "percent") input.inputMode = "decimal";
        input.maxLength = 120;
        input.placeholder = column.type === "percent" ? "Percent" : column.type === "currency" ? "Amount" : "Value";
        input.value = saved?.value || "";
        update = () => {
          const value = input.value.trim();
          if (value) filters.set(column.key, { op: mode.value, value });
          else filters.delete(column.key);
          applyFilters(true);
        };
        input.addEventListener("input", update);
        controls.append(mode.element, input);
        filterControls.set(column.key, { input, mode });
        filterRow.append(controls);
      }
      panel.append(filterRow);
    });
    filterButton.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      filterButton.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) panel.querySelector(".data-table-select-trigger, input")?.focus();
    });
    clearButton.addEventListener("click", () => {
      filters.clear();
      for (const control of filterControls.values()) {
        control.input.value = "";
        control.input.removeAttribute("aria-invalid");
        if (control.mode) control.mode.selectedIndex = 0;
      }
      applyFilters(true);
    });
    doc.addEventListener("click", (event) => {
      if (!panel.hidden && !filterWrap.contains(event.target) && !event.target.closest?.(".data-table-select-menu")) {
        panel.hidden = true;
        filterButton.setAttribute("aria-expanded", "false");
      }
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        panel.hidden = true;
        filterButton.setAttribute("aria-expanded", "false");
        filterButton.focus();
      }
    });
    const fillViewport = () => {
      if (!fillsTab || root.hidden || root.closest("[hidden]")) return;
      viewport.style.height = Math.max(240, window.innerHeight - viewport.getBoundingClientRect().top - footer.offsetHeight - 12) + "px";
    };
    viewport.addEventListener("scroll", schedule, { passive: true });
    doc.addEventListener("pages:tabchange", () => { fillViewport(); schedule(); });
    window.addEventListener("resize", fillViewport);
    if (typeof ResizeObserver === "function") new ResizeObserver(() => { fillViewport(); schedule(); }).observe(viewport);
    if (filters.size && !location.hash) {
      const url = new URL(location.href);
      url.hash = root.id;
      try { history.replaceState(null, "", url); } catch { /* opaque preview origin */ }
    }
    applyFilters(false);
    requestAnimationFrame(fillViewport);
  });
})();`;

// The link bridge, for BB previews only. The preview iframe has no popups and no top
// navigation, so a link click there does nothing or loads the site inside the frame.
// The bridge stops the click and asks the BB app to open the link instead. Fragment
// links scroll as usual. Links to another page of the same folder (our own `v` or `a`
// route next to this page) ask the BB app to load that page into this frame: the frame's
// own navigation would carry no BB session cookie, so it fails through a remote BB tunnel.
// Other links back to the preview server go nowhere.
export const LINK_BRIDGE = String.raw`(() => {
  "use strict";
  if (window.parent === window) return;
  const here = new URL(location.href);
  const routes = here.pathname.replace(/[^/]*$/u, "");
  const open = (event) => {
    if (event.defaultPrevented || event.button !== (event.type === "auxclick" ? 1 : 0)) return;
    const link = event.target instanceof Element ? event.target.closest("a[href], area[href]") : null;
    if (!link) return;
    const raw = (link.getAttribute("href") || "").trim();
    if (raw.startsWith("#") || /^javascript:/iu.test(raw)) return;
    event.preventDefault();
    let url;
    try { url = new URL(link.href, here); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return;
    if (url.protocol !== "mailto:" && url.origin === here.origin) {
      if (event.type === "click" && (url.pathname === routes + "v" || url.pathname === routes + "a")) {
        window.parent.postMessage({ source: "bb-pages", type: "open-page", url: url.href }, "*");
      }
      return;
    }
    window.parent.postMessage({ source: "bb-pages", type: "open-link", url: url.href }, "*");
  };
  document.addEventListener("click", open);
  document.addEventListener("auxclick", open);
})();`;
