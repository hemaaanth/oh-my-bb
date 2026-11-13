import { describe, expect, it } from "vitest";
import { answerLine, formFields, messageFor, replyParts } from "./answers.js";

const el = (typeName: string, props: Record<string, unknown>) => ({ type: "element", typeName, props, partial: false });

// Form("f", [Stack([Choice("check", [{label: "Yes, it shows", value: "yes"}, "No"], "Did it work?")]), Toggle("notify", "Notify me"), Input("release_target")], [Button("Send")])
const parsed = {
  root: el("Stack", { children: [el("Form", {
    name: "f",
    fields: [
      el("Stack", { children: [el("Choice", { name: "check", label: "Did it work?", options: [{ label: "Yes, it shows", value: "yes" }, "No"] })] }),
      el("Toggle", { name: "notify", label: "Notify me" }),
      el("Input", { name: "release_target" }),
    ],
    buttons: [el("Button", { label: "Send" })],
  })] }),
} as never;

const event = (button: string, answers: Record<string, unknown>) =>
  ({ humanFriendlyMessage: button, formName: "f", formState: { f: Object.fromEntries(Object.entries(answers).map(([name, value]) => [name, { value }])) } }) as never;

describe("reply text", () => {
  it("sends a lone answer as one line, with labels instead of names, and drops a generic Send", () => {
    expect(messageFor(event("Send", { check: "yes" }), formFields(parsed))).toBe("Did it work? Yes, it shows");
  });

  it("lists several answers, leaves out empty ones, and keeps a meaningful button", () => {
    const fields = formFields(parsed);
    expect(messageFor(event("Send", { notify: true, release_target: "", check: "No" }), fields)).toBe("- Did it work? No\n- Notify me: Yes");
    expect(messageFor(event("Approve", { release_target: "prod" }), fields)).toBe("Approve\n- Release target: prod");
  });

  it("still sends the button when nothing was answered", () => {
    expect(messageFor(event("Send", { notify: "" }))).toBe("Send");
  });

  it("joins a label and an answer the way a person would", () => {
    expect(answerLine("Which format?", "CSV")).toBe("Which format? CSV");
    expect(answerLine("Format:", "CSV")).toBe("Format: CSV");
  });

  it("splits a reply like a quoted chat reply: the answer in the bubble, the question in the quote", () => {
    const fields = formFields(parsed);
    expect(replyParts(event("Send", { check: "yes" }), fields)).toEqual({ text: "Yes, it shows", quote: "Did it work?", context: "Reply to a card:\nDid it work? Yes, it shows" });
    expect(replyParts(event("Send", { check: "No", notify: true }), fields, " Launch ")).toEqual({ text: "Did it work? No · Notify me: Yes", quote: "Launch", context: "Reply to a card:\n- Did it work? No\n- Notify me: Yes" });
    expect(replyParts(event("Approve", { release_target: "x".repeat(130) }), fields).text).toBe(`Approve\n\n- Release target: ${"x".repeat(130)}`);
    // A plain button has nothing to quote, and the agent needs no second copy.
    expect(replyParts(event("Show me the logs", {}))).toEqual({ text: "Show me the logs", context: null });
  });

  it("uses a Decision's question and option as they come", () => {
    const decision = { humanFriendlyMessage: "Launch date? Nov 4", formName: "launch", params: { quote: "Launch date?", answer: "Nov 4" } } as never;
    expect(replyParts(decision)).toEqual({ text: "Nov 4", quote: "Launch date?", context: "Reply to a card:\nLaunch date? Nov 4" });
  });
});
