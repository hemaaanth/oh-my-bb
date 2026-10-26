import type { ComposerDraftSnapshot, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { describe, expect, it } from "vitest";
import { AnswerSheet, type SheetEntry } from "./answerSheet.js";

function composer(text: string) {
  let draft: ComposerDraftSnapshot = { text, mentions: [], attachments: [] };
  const submitted = new Set<() => void>();
  const api = {
    key: "thread-test", scope: { kind: "thread", threadId: "thread-test" }, isSubmitting: false,
    get draft() { return draft; },
    replace(change: ComposerDraftSnapshot | ((current: ComposerDraftSnapshot) => ComposerDraftSnapshot)) {
      const replacement = typeof change === "function" ? change(draft) : change;
      draft = replacement === draft ? draft : { ...draft, ...replacement };
    },
    onSubmitted(callback: () => void) { submitted.add(callback); return () => submitted.delete(callback); },
  } as unknown as PluginComposerApi;
  return { api, text: () => draft.text, edit: (text: string) => { draft = { ...draft, text }; }, submit: () => { draft = { ...draft, text: "" }; for (const callback of submitted) callback(); } };
}
const answer = (text: string): Omit<SheetEntry, "seq"> => ({ block: "app-test", question: "app", selection: true, message: "message-test", reply: null, fence: 0, position: 0, text });

describe("app answer sheet", () => {
  it("changes and withdraws only its own text beside the owner's edits", () => {
    const host = composer("Owner note");
    const sheet = new AnswerSheet(null);
    const detach = sheet.attach(host.api);
    sheet.stage(answer("Count: 2"));
    expect(host.text()).toBe("Owner note\n\nCount: 2");
    host.edit(`Before\n\n${host.text()}`);
    sheet.observe(host.api);
    sheet.stage(answer("Count: 3"));
    expect(host.text()).toBe("Before\n\nOwner note\n\nCount: 3");
    sheet.withdraw("app-test", "app");
    expect(host.text()).toBe("Before\n\nOwner note");
    detach();
  });

  it("does not resurrect an old selection into a replacement draft after remount", () => {
    const host = composer("");
    const sheet = new AnswerSheet(null);
    const detach = sheet.attach(host.api);
    sheet.stage(answer("Old answer"));
    detach();
    host.edit("New owner draft");
    const release = sheet.attach(host.api);
    expect(host.text()).toBe("New owner draft");
    expect(sheet.snapshot("app-test").staged.size).toBe(0);
    release();
  });

  it("hands an edited answer to the owner and never overwrites it on a later pick", () => {
    const host = composer("");
    const sheet = new AnswerSheet(null);
    const detach = sheet.attach(host.api);
    sheet.stage(answer("Count: 2"));
    host.edit("Count: 2, with my own qualification");
    sheet.observe(host.api);
    expect(sheet.snapshot("app-test").staged.size).toBe(0);
    sheet.stage(answer("Count: 3"));
    expect(host.text()).toBe("Count: 2, with my own qualification\n\nCount: 3");
    detach();
  });

  it("stages an unmirrored pick when its composer appears and records native submission", () => {
    const sheet = new AnswerSheet(null);
    sheet.stage(answer("Count: 2"));
    const host = composer("Owner note");
    const detach = sheet.attach(host.api);
    expect(host.text()).toBe("Owner note\n\nCount: 2");
    host.submit();
    expect(sheet.snapshot("app-test").staged.size).toBe(0);
    expect(sheet.snapshot("app-test").sent).toEqual([{ question: "app", text: "Count: 2" }]);
    expect(host.text()).toBe("");
    detach();
  });
});
