// The text a card sends as the user's reply. BB shows it as a plain Markdown user message,
// so it reads like something a person typed: field labels, option labels, no generic "Send".
import type { ActionEvent, ParseResult } from "@openuidev/react-lang";

/** A form field's label and its option labels by value. */
type Field = { label?: string; options: Map<string, string> };
/** A Form's fields by name, and how many buttons it has. */
type FormInfo = { fields: Map<string, Field>; buttons: number };
/** Each Form by name, read from the parsed spec. */
export type FormFields = Map<string, FormInfo>;

type Element = { type: "element"; typeName: string; props: Record<string, unknown> };
const isElement = (value: unknown): value is Element =>
  Boolean(value) && typeof value === "object" && (value as { type?: unknown }).type === "element";

function optionLabels(options: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  if (!Array.isArray(options)) return labels;
  for (const option of options) {
    const { label, value } = (option ?? {}) as { label?: unknown; value?: unknown };
    if (typeof label === "string") labels.set(String(value ?? label), label);
  }
  return labels;
}

/** The labels of every Form field in a parsed spec. */
export function formFields(result: ParseResult | null | undefined): FormFields {
  const forms: FormFields = new Map();
  const walk = (value: unknown, form: Map<string, Field> | null): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item, form); return; }
    if (!isElement(value)) return;
    const { typeName, props } = value;
    if (typeName === "Form" && typeof props.name === "string") {
      const fields = new Map<string, Field>();
      const buttons = Array.isArray(props.buttons) ? props.buttons.filter(isElement).length : 0;
      forms.set(props.name, { fields, buttons });
      walk(props.fields, fields);
      return;
    }
    if (form && typeof props.name === "string") {
      form.set(props.name, { label: typeof props.label === "string" ? props.label : undefined, options: optionLabels(props.options ?? props.items) });
    }
    for (const prop of Object.values(props)) walk(prop, form);
  };
  walk(result?.root, null);
  return forms;
}

/** `Label: answer`, or `Question? answer` when the label already asks. */
export function answerLine(label: string, answer: string): string {
  const text = label.trim().replace(/:$/, "");
  return text.endsWith("?") ? `${text} ${answer}` : `${text}: ${answer}`;
}

/** `release_target` → `Release target`, for a field without a label. */
const humanize = (name: string): string => {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function show(value: unknown, field: Field | undefined): string {
  if (Array.isArray(value)) return value.map((item) => show(item, field)).filter(Boolean).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  const text = String(value ?? "").trim();
  return field?.options.get(text) ?? text;
}

/** Button labels that say nothing once the answers are there. */
const GENERIC = /^(send|submit|done|ok|okay|continue|go)$/i;

type Answer = { label: string; answer: string };

/**
 * The clicked button and each answered field in form order. With answers, the button is dropped when
 * its label is generic or it is the form's only button: clicking it chose nothing.
 */
function answersOf(event: ActionEvent, fields?: FormFields): { button: string; head: string; answers: Answer[] } {
  const form = event.formName ? event.formState?.[event.formName] : undefined;
  const info = event.formName ? fields?.get(event.formName) : undefined;
  const known = info?.fields;
  // In the form's own order: form state lists fields in the order they were touched.
  const order = [...(known?.keys() ?? [])];
  const rank = (name: string) => { const at = order.indexOf(name); return at < 0 ? order.length : at; };
  const entries = form && typeof form === "object" ? Object.entries(form as Record<string, { value?: unknown }>).sort(([a], [b]) => rank(a) - rank(b)) : [];
  const answers = entries.flatMap(([name, entry]) => {
    const field = known?.get(name);
    const answer = show(entry?.value, field);
    return answer ? [{ label: field?.label ?? humanize(name), answer }] : [];
  });
  const button = event.humanFriendlyMessage?.trim() ?? "";
  const chose = !GENERIC.test(button) && info?.buttons !== 1;
  return { button, head: answers.length && !chose ? "" : button, answers };
}

/**
 * The full reply: the clicked button, then each answered field as `- Label: answer`. A generic or
 * lone button is dropped, and a lone answer is one line. Empty fields are left out.
 */
export function messageFor(event: ActionEvent, fields?: FormFields): string {
  const { button, head, answers } = answersOf(event, fields);
  const lines = answers.map(({ label, answer }) => answerLine(label, answer));
  if (!head && lines.length === 1) return lines[0];
  return [head, ...lines.map((line) => `- ${line}`)].filter(Boolean).join("\n") || button;
}

/** A reply in three parts. */
export type ReplyParts = {
  /** What the user's bubble shows: only the answer. */
  text: string;
  /** The question and answer together, for the agent only. Null when `text` already says it all. */
  context: string | null;
  /** What the header above the bubble quotes: the question, or the card's heading. */
  quote?: string;
};

/** Short answers share one line; longer ones get a line each. */
const INLINE_MAX = 120;

/**
 * Split a reply like a quoted chat reply: the bubble holds the answer, the header quotes what it
 * answers, and the agent gets both. A Decision passes its `quote` and `answer` as action params.
 * `heading` is the card's heading, quoted when several fields were answered.
 */
export function replyParts(event: ActionEvent, fields?: FormFields, heading?: string): ReplyParts {
  const full = messageFor(event, fields);
  const withContext = (text: string, quote?: string): ReplyParts =>
    ({ text, context: text === full ? null : `Reply to a card:\n${full}`, ...(quote ? { quote } : {}) });
  const { quote, answer } = event.params ?? {};
  if (typeof quote === "string" && typeof answer === "string") return withContext(answer, quote);
  const { head, answers } = answersOf(event, fields);
  if (!answers.length) return withContext(full);
  if (!head && answers.length === 1) return withContext(answers[0].answer, answers[0].label);
  const lines = answers.map(({ label, answer }) => answerLine(label, answer));
  const inline = lines.join(" · ");
  const body = inline.length <= INLINE_MAX ? inline : lines.map((line) => `- ${line}`).join("\n");
  return withContext([head, body].filter(Boolean).join("\n\n"), heading?.trim() || undefined);
}
