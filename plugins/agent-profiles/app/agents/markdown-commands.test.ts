import { describe, expect, it } from "vitest";
import {
  applyMarkdownEdit,
  insertMarkdownLink,
  prefixMarkdown,
  wrapMarkdown,
  type MarkdownCommand,
} from "./markdown-commands";

/** Run a command on text where `«` and `»` mark the selection; return the result the same way. */
function run(command: MarkdownCommand, marked: string): string {
  const start = marked.indexOf("«");
  const end = marked.indexOf("»") - 1;
  const text = marked.replace("«", "").replace("»", "");
  const edit = command({ text, start, end });
  const next = applyMarkdownEdit(text, edit);
  return `${next.slice(0, edit.selectionStart)}«${next.slice(edit.selectionStart, edit.selectionEnd)}»${next.slice(edit.selectionEnd)}`;
}

const bold = wrapMarkdown("**", "bold text");
const italic = wrapMarkdown("*", "italic text");
const heading = prefixMarkdown("## ");
const bullet = prefixMarkdown("- ");

describe("wrapMarkdown", () => {
  it("wraps the selection and keeps it selected", () => {
    expect(run(bold, "a «word» b")).toBe("a **«word»** b");
    expect(run(italic, "a «word» b")).toBe("a *«word»* b");
  });

  it("inserts selected placeholder text when nothing is selected", () => {
    expect(run(bold, "a «»b")).toBe("a **«bold text»**b");
    expect(run(italic, "«»")).toBe("*«italic text»*");
  });

  it("unwraps a selection surrounded by the marker", () => {
    expect(run(bold, "a **«word»** b")).toBe("a «word» b");
    expect(run(italic, "a *«word»* b")).toBe("a «word» b");
  });

  it("unwraps a selection that includes the marker", () => {
    expect(run(bold, "a «**word**» b")).toBe("a «word» b");
    expect(run(italic, "a «*word*» b")).toBe("a «word» b");
  });

  it("does not treat bold markers as italic", () => {
    expect(run(italic, "a **«word»** b")).toBe("a ***«word»*** b");
    expect(run(italic, "a «**word**» b")).toBe("a *«**word**»* b");
    expect(run(italic, "a ***«word»*** b")).toBe("a **«word»** b");
  });

  it("removes an empty wrapper around the cursor", () => {
    expect(run(bold, "a **«»** b")).toBe("a «» b");
  });
});

describe("prefixMarkdown", () => {
  it("prefixes the cursor line and moves the cursor with it", () => {
    expect(run(heading, "one\ntw«»o\nthree")).toBe("one\n## tw«»o\nthree");
    expect(run(bullet, "«»")).toBe("- «»");
  });

  it("prefixes every selected line", () => {
    expect(run(bullet, "o«ne\ntwo\nthr»ee")).toBe("- o«ne\n- two\n- thr»ee");
  });

  it("skips a line the selection only reaches the start of", () => {
    expect(run(bullet, "«one\ntwo\n»three")).toBe("- «one\n- two\n»three");
  });

  it("removes the prefix when every line has it", () => {
    expect(run(bullet, "- o«ne\n- two»")).toBe("o«ne\ntwo»");
    expect(run(heading, "## «»Title")).toBe("«»Title");
  });

  it("adds the prefix when only some lines have it", () => {
    expect(run(bullet, "«- one\ntwo»")).toBe("- «- one\n- two»");
  });
});

describe("insertMarkdownLink", () => {
  it("links the selection and selects the URL", () => {
    expect(run(insertMarkdownLink, "see «docs» now")).toBe("see [docs](«https://») now");
  });

  it("uses placeholder text when nothing is selected", () => {
    const edit = insertMarkdownLink({ text: "x", start: 1, end: 1 });
    expect(applyMarkdownEdit("x", edit)).toBe("x[link text](https://)");
    expect("x[link text](https://)".slice(edit.selectionStart, edit.selectionEnd)).toBe("https://");
  });
});
