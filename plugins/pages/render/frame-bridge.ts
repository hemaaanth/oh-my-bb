// The frame bridge: the page side of the postMessage link between a BB preview and the BB app
// (protocol in contract.ts FRAME_MESSAGE, host side in app/bridge.ts). injectPage adds it only to
// BB previews, never to published or shared sites; those get FORMS_OFFLINE when they have a form.
// Like the page runtime, both are plain strings.
import { FORM_STATE_ATTRIBUTE, FRAME_MESSAGE, MANUAL_FORM_ATTRIBUTE } from "../contract.js";

/** The form status line. The bridge adds one to a form that has none, so a page can place its own. */
export const FORM_STATUS_ATTRIBUTE = "data-bb-pages-status";

/** Shared sites cannot reach BB, so a submitted form says where to send it instead of failing silently. */
export const FORMS_OFFLINE = String.raw`(() => {
  "use strict";
  window.addEventListener("submit", (event) => {
    const form = event.target;
    if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.hasAttribute(${JSON.stringify(MANUAL_FORM_ATTRIBUTE)}) || form.method === "dialog") return;
    event.preventDefault();
    let line = form.querySelector("[${FORM_STATUS_ATTRIBUTE}]");
    if (!line) { line = document.createElement("p"); line.setAttribute(${JSON.stringify(FORM_STATUS_ATTRIBUTE)}, ""); line.setAttribute("role", "status"); form.append(line); }
    line.textContent = "Open this page in BB to send your answers.";
  });
})();`;

export const FRAME_BRIDGE = String.raw`(() => {
  "use strict";
  if (window.parent === window) return;
  const root = document.documentElement;
  const post = (message) => window.parent.postMessage(message, "*");

  // ---- Theme: later app theme changes arrive here, so the frame never reloads --
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window.parent || !data || data.type !== ${JSON.stringify(FRAME_MESSAGE.theme)}) return;
    if (data.theme === "light" || data.theme === "dark") root.setAttribute("data-bb-theme", data.theme);
  });

  // ---- Links: the sandbox cannot open windows, so the host opens http(s) links --
  // Bubble phase, so a page that handles its own clicks (preventDefault) keeps them. In-page links stay here.
  // A link to another page of a folder (the sibling /v or /a route) goes to the host too: the host sets
  // the frame src, so the request carries the BB session. The frame's own navigation would not.
  const routes = location.pathname.replace(/[^/]*$/u, "");
  window.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link = event.composedPath().find((node) => node instanceof Element && node.matches("a[href]"));
    if (!link) return;
    let url;
    try { url = new URL(link.getAttribute("href"), document.baseURI); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.href.split("#")[0] === location.href.split("#")[0]) return;
    event.preventDefault();
    const page = url.origin === location.origin && (url.pathname === routes + "v" || url.pathname === routes + "a");
    post({ type: page ? ${JSON.stringify(FRAME_MESSAGE.page)} : ${JSON.stringify(FRAME_MESSAGE.open)}, url: url.href });
  });

  // ---- Forms: the host sends a submitted form to the thread as one message --
  // Bubble phase, like links: a form the page cancels itself, or one marked manual, stays with the page.
  // A sent form stays locked and marked sent until the reader picks Edit answers. The host restores
  // forms sent before, so a reload shows them sent too.
  const STATUS = ${JSON.stringify(FORM_STATUS_ATTRIBUTE)};
  const STATE = ${JSON.stringify(FORM_STATE_ATTRIBUTE)};
  const CHOSEN = "data-bb-pages-chosen";
  const pending = new Map();
  const lockedBy = new WeakMap();
  const words = (text) => (text || "").replace(/\s+/g, " ").trim();
  const textOf = (node) => {
    if (!node) return "";
    const copy = node.cloneNode(true);
    for (const child of copy.querySelectorAll("input,select,textarea,button,option,[" + STATUS + "]")) child.remove();
    return words(copy.textContent);
  };
  const labelsOf = (control) => Array.from(control.labels || []).map(textOf).find(Boolean) || "";
  const legendOf = (control) => { const set = control.closest("fieldset"); return set ? textOf(set.querySelector("legend")) : ""; };
  const SKIPPED = new Set(["submit", "reset", "button", "image", "file"]);
  const fieldsOf = (form) => Array.from(form.elements).filter((control) =>
    /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) && control.name && !control.disabled && !SKIPPED.has(control.type));
  // A choice's value as the reader saw it: its value attribute, else its label.
  const choiceOf = (control) => control.hasAttribute("value") ? control.value : labelsOf(control) || control.value;
  // Every named field once, in page order, under the label the reader saw. Blank answers count.
  // A group of choices is named by data-label or its legend, never by one option's text.
  const answersOf = (form) => {
    const fields = fieldsOf(form);
    const answers = [];
    const seen = new Set();
    for (const control of fields) {
      if (seen.has(control.name)) continue;
      seen.add(control.name);
      const group = fields.filter((other) => other.name === control.name);
      const choices = control.type === "radio" || (control.type === "checkbox" && group.length > 1);
      const label = words(control.getAttribute("data-label")) || (choices ? legendOf(control) : words(control.getAttribute("aria-label")) || labelsOf(control) || legendOf(control) || words(control.placeholder)) || control.name;
      let value;
      if (control.type === "radio") { const picked = group.find((item) => item.checked); value = picked ? choiceOf(picked) : ""; }
      else if (control.type === "checkbox") value = choices ? group.filter((item) => item.checked).map(choiceOf) : control.checked;
      else if (control.tagName === "SELECT" && control.multiple) value = Array.from(control.selectedOptions).map((option) => option.value);
      else value = control.value;
      answers.push({ name: control.name, label, value });
    }
    return answers;
  };
  // Puts sent answers back, the reverse of answersOf. A field the page no longer has is skipped.
  const fill = (form, answers) => {
    const fields = fieldsOf(form);
    for (const { name, value } of answers) {
      for (const control of fields.filter((item) => item.name === name)) {
        if (control.type === "radio") control.checked = choiceOf(control) === value;
        else if (control.type === "checkbox") control.checked = Array.isArray(value) ? value.includes(choiceOf(control)) : value === true;
        else if (control.tagName === "SELECT" && control.multiple) { for (const option of control.options) option.selected = Array.isArray(value) && value.includes(option.value); }
        else if (typeof value === "string") control.value = value;
      }
    }
  };
  const isSubmitter = (control) => (control.tagName === "BUTTON" && (control.type || "submit") === "submit") || (control.tagName === "INPUT" && (control.type === "submit" || control.type === "image"));
  const buttonText = (control) => words(control.value) || words(control.textContent);
  // The clicked button is the action when it names one: a value, a name, or one of several submit buttons.
  const actionOf = (form, submitter) => {
    if (!submitter) return null;
    const text = buttonText(submitter);
    const several = Array.from(form.elements).filter(isSubmitter).length > 1;
    return text && (submitter.hasAttribute("value") || submitter.name || several) ? text : null;
  };
  const titleOf = (form) => words(form.getAttribute("data-title")) || words(form.getAttribute("aria-label")) || textOf(form.querySelector("h1,h2,h3,h4")) || null;
  // The form's name on its page: its id, its name, or its place among the page's forms.
  const keyOf = (form) => (words(form.id) || words(form.getAttribute("name")) || "form-" + Array.from(document.forms).indexOf(form)).slice(0, 200);
  const handled = (form) => !form.hasAttribute(${JSON.stringify(MANUAL_FORM_ATTRIBUTE)}) && form.method !== "dialog";
  // The status line goes in the form's .actions row when it has one, else at the end of the form.
  const say = (form, text, edit) => {
    let line = form.querySelector("[" + STATUS + "]");
    if (!line) {
      line = document.createElement("p");
      line.setAttribute(STATUS, "");
      line.setAttribute("role", "status");
      (form.querySelector(".actions") || form).append(line);
    }
    line.replaceChildren(text);
    if (!edit) return;
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-bb-pages-edit", "");
    button.textContent = "Edit answers";
    button.addEventListener("click", () => unlock(form, "Change your answers, then send again."));
    line.append(" ", button);
  };
  const lock = (form) => {
    const locked = Array.from(form.elements).filter((control) => !control.disabled);
    for (const control of locked) control.disabled = true;
    lockedBy.set(form, locked);
  };
  const unlock = (form, text) => {
    for (const control of lockedBy.get(form) || []) control.disabled = false;
    lockedBy.delete(form);
    form.removeAttribute(STATE);
    for (const button of form.querySelectorAll("[" + CHOSEN + "]")) button.removeAttribute(CHOSEN);
    say(form, text);
  };
  // The clicked button stays marked: by its action, else the form's only submit button.
  const markSent = (form, action, text) => {
    form.setAttribute(STATE, "sent");
    const submitters = Array.from(form.elements).filter(isSubmitter);
    if (action !== null) for (const control of submitters) control.toggleAttribute(CHOSEN, buttonText(control) === action);
    else if (submitters.length === 1) submitters[0].setAttribute(CHOSEN, "");
    say(form, text, true);
  };
  const settle = (submissionId, ok, text) => {
    const entry = pending.get(submissionId);
    if (!entry) return;
    pending.delete(submissionId);
    clearTimeout(entry.timer);
    entry.form.removeAttribute("aria-busy");
    if (ok) return markSent(entry.form, entry.action, "Sent to the thread.");
    unlock(entry.form, text);
    entry.form.setAttribute(STATE, "error");
  };
  window.addEventListener("submit", (event) => {
    const form = event.target;
    if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !handled(form)) return;
    event.preventDefault();
    if (form.getAttribute("aria-busy") === "true" || form.getAttribute(STATE) === "sent") return;
    const submissionId = "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    // Read the answers first: disabled fields are not answers.
    const action = actionOf(form, event.submitter);
    const message = { type: ${JSON.stringify(FRAME_MESSAGE.submit)}, submissionId, formKey: keyOf(form), formTitle: titleOf(form), action, answers: answersOf(form) };
    lock(form);
    form.setAttribute("aria-busy", "true");
    form.setAttribute(STATE, "sending");
    if (event.submitter) event.submitter.setAttribute(CHOSEN, "");
    pending.set(submissionId, { form, action, timer: setTimeout(() => settle(submissionId, false, "BB did not answer. Send again."), 20000) });
    say(form, "Sending…");
    post(message);
  });
  const sentAt = (time) => { const date = new Date(time); return isNaN(date) ? "" : " " + date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); };
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window.parent || !data) return;
    if (data.type === ${JSON.stringify(FRAME_MESSAGE.submitted)} && typeof data.submissionId === "string") {
      settle(data.submissionId, data.ok === true, typeof data.message === "string" && data.message ? data.message.slice(0, 300) : "The form could not be sent.");
    } else if (data.type === ${JSON.stringify(FRAME_MESSAGE.restore)} && Array.isArray(data.forms)) {
      for (const sent of data.forms) {
        const form = Array.from(document.forms).find((item) => handled(item) && keyOf(item) === sent.formKey);
        if (!form || form.getAttribute("aria-busy") === "true" || form.getAttribute(STATE) === "sent" || !Array.isArray(sent.answers)) continue;
        fill(form, sent.answers);
        lock(form);
        markSent(form, typeof sent.action === "string" ? sent.action : null, "Sent to the thread" + sentAt(sent.sentAt) + ".");
      }
    }
  });

  // ---- Height: an inline frame fits its page, so the page reports its content height --
  if (root.getAttribute("data-bb-frame") !== "inline" || typeof ResizeObserver !== "function") return;
  let last = -1;
  const report = () => {
    // Taller than the frame: the scroll height. Shorter: the root's own box, which the viewport does not stretch.
    const height = Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    post({ type: ${JSON.stringify(FRAME_MESSAGE.height)}, height });
  };
  const observer = new ResizeObserver(report);
  observer.observe(root);
  const ready = () => { if (document.body) observer.observe(document.body); report(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
  window.addEventListener("load", report);
})();`;
