// The form runtime: themed pickers for <select>, date, and time fields, and steppers for number fields.
// The browser draws the popups of these fields itself, so CSS cannot style them. This runtime stops the
// browser popup and opens its own, in the theme. The field stays the real field: it holds the value, the
// label, and the form answer. data-bb-pages-native on a field or an ancestor keeps the browser popup.
// injectPage adds it inline only to pages that have one of these fields. It is a plain string, not a
// bundled module, so the bytes shipped are exactly the bytes written here.

/** True when the page has a field the form runtime replaces the browser popup or spin buttons for. */
export function needsFormRuntime(html: string): boolean {
  return /<select[\s>]/iu.test(html) || /\btype\s*=\s*["']?(?:date|time|number)\b/iu.test(html);
}

export const FORM_RUNTIME = String.raw`(() => {
  "use strict";
  const doc = document;
  const root = doc.documentElement;
  if (root.hasAttribute("data-bb-pickers")) return;
  // The theme hides the browser picker icons and spin buttons only under this mark, so a page without the runtime keeps them.
  root.setAttribute("data-bb-pickers", "");
  const NATIVE = "[data-bb-pages-native]";
  const inline = root.getAttribute("data-bb-frame") === "inline";
  let uid = 0;

  const make = (tag, className) => {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    return el;
  };
  const fire = (control) => {
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const icon = (path) => '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="' + path + '"/></svg>';
  // "select", "date", "time", or "" for a field the runtime leaves alone.
  const kind = (el) => {
    if (!(el instanceof Element) || el.closest(NATIVE)) return "";
    if (el.tagName === "SELECT") return el.multiple || el.size > 1 ? "" : "select";
    if (el.tagName === "INPUT" && (el.type === "date" || el.type === "time")) return el.type;
    return "";
  };
  const usable = (control) => !control.disabled && !control.readOnly;

  // ---- The open picker: one at a time, fixed below its field ---------------
  let open = null;

  const close = (refocus) => {
    if (!open) return;
    const current = open;
    open = null;
    current.el.remove();
    if (current.spacer) current.spacer.remove();
    current.control.setAttribute("aria-expanded", "false");
    current.control.removeAttribute("aria-controls");
    if (refocus) current.control.focus({ preventScroll: true });
  };

  const place = () => {
    if (!open) return;
    const { control, el } = open;
    el.style.maxHeight = "";
    const box = control.getBoundingClientRect();
    if (open.list) el.style.minWidth = Math.round(box.width) + "px";
    const gap = 4;
    const edge = 8;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const below = window.innerHeight - box.bottom - gap - edge;
    const above = box.top - gap - edge;
    let top;
    if (height <= below) top = box.bottom + gap;
    else if (height <= above) top = box.top - gap - height;
    else if (inline) {
      // An inline frame fits its page, so grow the page; the frame follows on its next height report.
      if (!open.spacer) {
        open.spacer = make("div", "bb-picker-spacer");
        open.spacer.setAttribute("aria-hidden", "true");
        root.append(open.spacer);
      }
      open.spacer.style.height = (parseFloat(open.spacer.style.height) || 0) + Math.ceil(height - below) + "px";
      top = box.bottom + gap;
    } else if (below >= above) {
      el.style.maxHeight = Math.max(below, 120) + "px";
      top = box.bottom + gap;
    } else {
      const room = Math.max(above, 120);
      el.style.maxHeight = room + "px";
      top = box.top - gap - Math.min(height, room);
    }
    const right = (root.clientWidth || window.innerWidth) - width - edge;
    el.style.top = Math.round(top) + "px";
    el.style.left = Math.round(Math.max(edge, Math.min(box.left, right))) + "px";
  };

  // Shows el as the picker of control. The picker sits outside <body>, so it never changes the page's own layout.
  const mount = (control, el, list = false) => {
    close(false);
    el.classList.add("bb-picker");
    if (!el.id) el.id = "bb-picker-" + ++uid;
    // A click in the picker keeps the focus where it is: in the field, or in the picker.
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    });
    open = { control, el, list, spacer: null, sync: null };
    control.setAttribute("aria-expanded", "true");
    control.setAttribute("aria-controls", el.id);
    root.append(el);
    place();
    return open;
  };

  // ---- List picker: select options and times --------------------------------
  // items: { value, label, disabled, selected, near } or { group }. pick gets the chosen item.
  const openList = (control, items, focus, pick) => {
    const el = make("div", "bb-picker-list");
    const id = "bb-picker-" + ++uid;
    el.id = id;
    el.setAttribute("role", "listbox");
    el.tabIndex = -1;
    const label = control.labels && control.labels[0];
    if (label) el.setAttribute("aria-label", label.textContent.trim());
    const options = [];
    for (const item of items) {
      if (item.group !== undefined) {
        const head = make("div", "bb-picker-group");
        head.setAttribute("role", "presentation");
        head.textContent = item.group;
        el.append(head);
        continue;
      }
      const option = make("div", "bb-picker-option");
      option.id = id + "-" + options.length;
      option.dataset.index = String(options.length);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", item.selected ? "true" : "false");
      if (item.disabled) option.setAttribute("aria-disabled", "true");
      option.textContent = item.label;
      el.append(option);
      options.push({ option, item });
    }
    const state = mount(control, el, true);

    let active = -1;
    const reveal = (option, center) => {
      if (center) el.scrollTop = option.offsetTop - (el.clientHeight - option.offsetHeight) / 2;
      else if (option.offsetTop < el.scrollTop) el.scrollTop = option.offsetTop - 4;
      else if (option.offsetTop + option.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = option.offsetTop + option.offsetHeight - el.clientHeight + 4;
    };
    const activate = (index, scroll) => {
      if (active >= 0) options[active].option.classList.remove("is-active");
      active = index;
      if (index < 0) return el.removeAttribute("aria-activedescendant");
      options[index].option.classList.add("is-active");
      el.setAttribute("aria-activedescendant", options[index].option.id);
      if (scroll) reveal(options[index].option, false);
    };
    // The next enabled option from "from" in direction "by", or "from" when there is none.
    const move = (from, by, count = 1) => {
      let found = from;
      for (let index = from + by; index >= 0 && index < options.length && count > 0; index += by) {
        if (options[index].item.disabled) continue;
        found = index;
        count--;
      }
      return found;
    };
    const choose = (index) => {
      if (index < 0 || options[index].item.disabled) return;
      close(true);
      if (usable(control)) pick(options[index].item);
    };

    let typed = "";
    let typedAt = 0;
    el.addEventListener("keydown", (event) => {
      const key = event.key;
      const typing = Date.now() - typedAt < 700;
      if (key === "ArrowDown") activate(move(active, 1), true);
      else if (key === "ArrowUp") activate(move(active, -1), true);
      else if (key === "PageDown") activate(move(active, 1, 8), true);
      else if (key === "PageUp") activate(move(active, -1, 8), true);
      else if (key === "Home") activate(move(-1, 1), true);
      else if (key === "End") activate(move(options.length, -1), true);
      else if (key === "Enter" || (key === " " && !typing)) choose(active);
      else if (key === "Tab") return close(true);
      else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Type-ahead: letters typed close together find the next option that starts with them.
        typed = (typing ? typed : "") + key.toLowerCase();
        typedAt = Date.now();
        const first = typed.length > 1 ? active : active + 1;
        for (let step = 0; step < options.length; step++) {
          const index = (((first + step) % options.length) + options.length) % options.length;
          if (!options[index].item.disabled && options[index].item.label.toLowerCase().startsWith(typed)) {
            activate(index, true);
            break;
          }
        }
      } else return;
      event.preventDefault();
      event.stopPropagation();
    });
    el.addEventListener("mousemove", (event) => {
      const option = event.target instanceof Element && event.target.closest(".bb-picker-option");
      if (!option) return;
      const index = Number(option.dataset.index);
      if (index !== active && !options[index].item.disabled) activate(index, false);
    });
    el.addEventListener("click", (event) => {
      const option = event.target instanceof Element && event.target.closest(".bb-picker-option");
      if (option) choose(Number(option.dataset.index));
    });
    // Typing in the field moves the mark to the matching option.
    state.sync = () => {
      const value = control.value.slice(0, 5);
      let hit = -1;
      options.forEach(({ option, item }, index) => {
        option.setAttribute("aria-selected", item.value === value ? "true" : "false");
        if (item.value === value) hit = index;
      });
      if (hit >= 0) activate(hit, true);
    };

    let start = options.findIndex(({ item }) => item.selected);
    if (start < 0) start = options.findIndex(({ item }) => item.near && !item.disabled);
    if (start < 0) start = move(-1, 1);
    activate(start, false);
    if (start >= 0) reveal(options[start].option, true);
    if (focus) el.focus({ preventScroll: true });
  };

  const openSelect = (select, focus) => {
    const items = [];
    const add = (option, groupDisabled) => {
      if (option.tagName !== "OPTION" || option.hidden) return;
      items.push({ value: option.value, label: option.label || option.text, disabled: option.disabled || groupDisabled, selected: option.selected, option });
    };
    for (const child of select.children) {
      if (child.tagName !== "OPTGROUP") add(child, false);
      else {
        items.push({ group: child.label });
        for (const option of child.children) add(option, child.disabled);
      }
    }
    openList(select, items, focus, (item) => {
      if (item.option.selected) return;
      item.option.selected = true;
      fire(select);
    });
  };

  // ---- Time picker: a list at the field's step, 15 minutes by default ---------
  const pad = (number, width = 2) => String(number).padStart(width, "0");
  const minutesOf = (value) => {
    const match = /^(\d\d):(\d\d)/.exec(value || "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const timeLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

  const openTime = (input, focus) => {
    const step = Number(input.step);
    const every = step >= 300 && step % 60 === 0 ? step / 60 : 15;
    const min = minutesOf(input.min);
    const max = minutesOf(input.max);
    // min after max is a range across midnight.
    const allowed = (time) => min !== null && max !== null && min > max ? time >= min || time <= max : (min === null || time >= min) && (max === null || time <= max);
    const current = minutesOf(input.value);
    const now = new Date();
    const target = current !== null ? current : now.getHours() * 60 + now.getMinutes();
    const items = [];
    let near = false;
    for (let offset = 0; offset < 1440; offset += every) {
      const time = ((min === null ? 0 : min) + offset) % 1440;
      if (!allowed(time)) continue;
      const hours = Math.floor(time / 60);
      const minutes = time % 60;
      const item = { value: pad(hours) + ":" + pad(minutes), label: timeLabel.format(new Date(2000, 0, 1, hours, minutes)), disabled: false, selected: time === current, near: false };
      if (!near && time >= target) near = item.near = true;
      items.push(item);
    }
    openList(input, items, focus, (item) => {
      if (input.value.slice(0, 5) === item.value) return;
      input.value = item.value;
      fire(input);
    });
  };

  // ---- Date picker: a month calendar ------------------------------------------
  const isoOf = (date) => pad(date.getFullYear(), 4) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  const dateOf = (value) => {
    const match = /^(\d{4,})-(\d\d)-(\d\d)$/.exec(value || "");
    if (!match) return null;
    const date = new Date(2000, Number(match[2]) - 1, Number(match[3]));
    date.setFullYear(Number(match[1]));
    return date;
  };
  const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  const addMonths = (date, months) => {
    const last = new Date(date.getFullYear(), date.getMonth() + months + 1, 0).getDate();
    return new Date(date.getFullYear(), date.getMonth() + months, Math.min(date.getDate(), last));
  };
  const firstDay = (() => {
    try {
      const locale = new Intl.Locale(navigator.language);
      const info = typeof locale.getWeekInfo === "function" ? locale.getWeekInfo() : locale.weekInfo;
      return info ? info.firstDay % 7 : 0;
    } catch {
      return 0;
    }
  })();
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  const dayLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });
  const weekdayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const CHEVRON_LEFT = icon("M9.75 4.5 6.25 8l3.5 3.5");
  const CHEVRON_RIGHT = icon("M6.25 4.5 9.75 8l-3.5 3.5");

  const openCalendar = (input, focus) => {
    const el = make("div", "bb-picker-calendar");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Choose a date");
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const allowed = (date) => {
      const value = isoOf(date);
      return (!input.min || value >= input.min) && (!input.max || value <= input.max);
    };
    const clamp = (date) => input.min && isoOf(date) < input.min ? dateOf(input.min) || date : input.max && isoOf(date) > input.max ? dateOf(input.max) || date : date;
    let active = clamp(dateOf(input.value) || today);

    const button = (className, label, html) => {
      const element = make("button", className);
      element.type = "button";
      if (label) element.setAttribute("aria-label", label);
      element.innerHTML = html;
      return element;
    };
    const head = make("div", "bb-picker-head");
    const title = make("div", "bb-picker-title");
    title.setAttribute("aria-live", "polite");
    const prev = button("bb-picker-nav", "Previous month", CHEVRON_LEFT);
    const next = button("bb-picker-nav", "Next month", CHEVRON_RIGHT);
    head.append(title, prev, next);
    const weekdays = make("div", "bb-picker-weekdays");
    weekdays.setAttribute("aria-hidden", "true");
    for (let day = 0; day < 7; day++) {
      const name = make("span");
      // 2024-01-07 was a Sunday.
      name.textContent = weekdayLabel.format(new Date(2024, 0, 7 + ((firstDay + day) % 7))).slice(0, 2);
      weekdays.append(name);
    }
    const grid = make("div", "bb-picker-days");
    const foot = make("div", "bb-picker-foot");
    const clear = button("bb-picker-text", "", "Clear");
    const goToday = button("bb-picker-text", "", "Today");
    foot.append(clear, goToday);
    el.append(head, weekdays, grid, foot);

    const render = (focusDay) => {
      title.textContent = monthLabel.format(active);
      grid.textContent = "";
      const first = new Date(active.getFullYear(), active.getMonth(), 1);
      const start = addDays(first, -((first.getDay() - firstDay + 7) % 7));
      const activeValue = isoOf(active);
      // Always six weeks, so the picker keeps its height from month to month.
      for (let index = 0; index < 42; index++) {
        const date = addDays(start, index);
        const value = isoOf(date);
        const day = button("bb-picker-day", dayLabel.format(date), String(date.getDate()));
        day.dataset.date = value;
        day.tabIndex = value === activeValue ? 0 : -1;
        if (date.getMonth() !== active.getMonth()) day.classList.add("is-outside");
        if (value === isoOf(today)) day.setAttribute("aria-current", "date");
        if (value === input.value) day.setAttribute("aria-pressed", "true");
        if (!allowed(date)) day.disabled = true;
        grid.append(day);
      }
      prev.disabled = Boolean(input.min) && isoOf(new Date(active.getFullYear(), active.getMonth(), 0)) < input.min;
      next.disabled = Boolean(input.max) && isoOf(new Date(active.getFullYear(), active.getMonth() + 1, 1)) > input.max;
      goToday.disabled = !allowed(today);
      if (focusDay) grid.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
    };
    const pick = (value) => {
      close(true);
      if (!usable(input) || input.value === value) return;
      input.value = value;
      fire(input);
    };
    const inPicker = () => el.contains(doc.activeElement);

    prev.addEventListener("click", () => { active = clamp(addMonths(active, -1)); render(inPicker()); });
    next.addEventListener("click", () => { active = clamp(addMonths(active, 1)); render(inPicker()); });
    clear.addEventListener("click", () => pick(""));
    goToday.addEventListener("click", () => pick(isoOf(today)));
    grid.addEventListener("click", (event) => {
      const day = event.target instanceof Element && event.target.closest(".bb-picker-day");
      if (day && !day.disabled) pick(day.dataset.date);
    });
    grid.addEventListener("keydown", (event) => {
      const offset = (active.getDay() - firstDay + 7) % 7;
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -offset, End: 6 - offset };
      let date;
      if (event.key in moves) date = addDays(active, moves[event.key]);
      else if (event.key === "PageUp" || event.key === "PageDown") date = addMonths(active, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
      else return;
      event.preventDefault();
      active = clamp(date);
      render(true);
    });

    render(false);
    const state = mount(input, el);
    // Typing in the field moves the calendar to the typed date.
    state.sync = () => {
      const date = dateOf(input.value);
      if (date) active = clamp(date);
      render(false);
    };
    if (focus) render(true);
  };

  const openFor = (control, focus) => {
    const type = kind(control);
    if (type === "select") openSelect(control, focus);
    else if (type === "date") openCalendar(control, focus);
    else if (type === "time") openTime(control, focus);
  };

  // ---- Events: stop the browser popup, open ours ---------------------------
  doc.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || (open && open.el.contains(event.target))) return;
    const control = event.target instanceof Element ? event.target.closest("select, input") : null;
    const type = control ? kind(control) : "";
    if (open && open.control === control) {
      // A second press on a select closes its list. A press in a date or time field places the caret.
      if (type === "select") {
        event.preventDefault();
        close(true);
      }
      return;
    }
    close(false);
    if (type !== "select" || !usable(control)) return;
    event.preventDefault();
    control.focus({ preventScroll: true });
    openSelect(control, true);
  }, true);

  doc.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const stepper = target && target.closest(".bb-number-step");
    if (stepper) return stepClick(stepper);
    const type = target ? kind(target) : "";
    if (type !== "date" && type !== "time") return;
    // Firefox opens its own picker on a click in the field.
    event.preventDefault();
    if ((open && open.control === target) || !usable(target)) return;
    // Opened by the pointer, the picker leaves the focus in the field, so typing still works.
    openFor(target, false);
  });

  doc.addEventListener("keydown", (event) => {
    const control = event.target;
    const type = kind(control);
    if (!type) return;
    const key = event.key;
    if (open && open.control === control) {
      if (key === "Escape") {
        event.preventDefault();
        close(true);
      } else if (key === "F4" || (event.altKey && key === "ArrowDown")) {
        event.preventDefault();
        openFor(control, true);
      }
      return;
    }
    const opens = key === "F4" || (event.altKey && key === "ArrowDown") ||
      (type === "select" && !event.altKey && !event.ctrlKey && !event.metaKey && (key === "Enter" || key === " " || key === "ArrowDown" || key === "ArrowUp"));
    if (!opens || !usable(control)) return;
    event.preventDefault();
    openFor(control, true);
  });

  doc.addEventListener("focusin", (event) => {
    if (open && event.target !== open.control && !open.el.contains(event.target)) close(false);
  });
  doc.addEventListener("input", (event) => {
    if (open && event.target === open.control && open.sync) open.sync();
  });
  doc.addEventListener("scroll", (event) => {
    if (open && !open.el.contains(event.target)) place();
  }, true);
  window.addEventListener("resize", place);
  window.addEventListener("blur", () => close(false));

  // ---- Number steppers: - and + inside the field --------------------------
  const MINUS = icon("M4 8h8");
  const PLUS = icon("M4 8h8M8 4v8");
  const wrapNumber = (input) => {
    if (input.closest(NATIVE) || !input.parentElement || input.parentElement.classList.contains("bb-number")) return;
    const wrap = make("span", "bb-number");
    input.before(wrap);
    wrap.append(input);
    for (const [by, label, html] of [[-1, "Decrease", MINUS], [1, "Increase", PLUS]]) {
      const button = make("button", "bb-number-step");
      button.type = "button";
      // The arrow keys step the field, so the buttons stay out of the tab order.
      button.tabIndex = -1;
      button.dataset.by = String(by);
      button.setAttribute("aria-label", label);
      button.innerHTML = html;
      wrap.append(button);
    }
  };
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches('input[type="number"]')) wrapNumber(node);
    else node.querySelectorAll('input[type="number"]').forEach(wrapNumber);
  };
  const step = (button) => {
    const input = button.parentElement && button.parentElement.querySelector("input");
    if (!input || !usable(input)) return;
    const before = input.value;
    const by = Number(button.dataset.by);
    try {
      if (by > 0) input.stepUp();
      else input.stepDown();
    } catch {
      // step="any" has no step: move by one, inside min and max.
      let value = (Number(input.value) || 0) + by;
      if (input.min !== "" && value < Number(input.min)) value = Number(input.min);
      if (input.max !== "" && value > Number(input.max)) value = Number(input.max);
      input.value = String(value);
    }
    if (input.value !== before) fire(input);
  };
  // Holding a button repeats the step; the click that ends a hold does not step again.
  let holdDelay = 0;
  let holdRepeat = 0;
  let held = false;
  const release = () => {
    clearTimeout(holdDelay);
    clearInterval(holdRepeat);
  };
  const stepClick = (button) => {
    if (held) held = false;
    else step(button);
  };
  doc.addEventListener("pointerdown", (event) => {
    const button = event.target instanceof Element && event.target.closest(".bb-number-step");
    if (!button || event.button !== 0) return;
    // Keep the focus where it is.
    event.preventDefault();
    release();
    held = false;
    holdDelay = setTimeout(() => {
      held = true;
      step(button);
      holdRepeat = setInterval(() => step(button), 70);
    }, 400);
  });
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", release);

  scan(doc.body || root);
  new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(scan);
  }).observe(root, { childList: true, subtree: true });
})();`;
