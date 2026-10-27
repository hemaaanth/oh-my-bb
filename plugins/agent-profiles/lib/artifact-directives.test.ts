import { describe, expect, it } from "vitest";
import { pageHref, parseArtifactDirectives } from "./artifact-directives";

const first = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  revision: "123e4567-e89b-42d3-a456-426614174001",
};
const second = {
  id: "223e4567-e89b-42d3-a456-426614174000",
  revision: "223e4567-e89b-42d3-a456-426614174001",
};
const directive = ({ id, revision }: typeof first) =>
  `::artifact{id="${id}" revision="${revision}"}`;
const pageDirective = ({ id, revision }: typeof first) =>
  `::page{id="${id}" version="${revision}"}`;
const references = (text: string) =>
  parseArtifactDirectives(text).flatMap((segment) =>
    segment.kind === "artifact" ? [segment.reference] : [],
  );

describe("page directives", () => {
  it("extracts ::page and legacy ::artifact directives in message order", () => {
    const segments = parseArtifactDirectives(
      `First report\n${pageDirective(first)}\nThen ${directive(second)} done.`,
    );

    expect(
      segments.flatMap((segment) =>
        segment.kind === "artifact" ? [segment.reference] : [],
      ),
    ).toEqual([first, second]);
    expect(segments.at(-1)).toEqual({ kind: "text", text: " done." });
  });

  it("accepts the optional ::page height", () => {
    expect(references(`::page{id="${first.id}" version="${first.revision}" height="400"}`)).toEqual([first]);
  });

  it("leaves malformed and invalid identifiers as ordinary text", () => {
    const text = [
      "::artifact{id=not-a-uuid revision=also-bad}",
      `::artifact{id="${first.id}"}`,
      `::artifact{id="${first.id}" revision="${first.revision}" extra="x"}`,
      `::artifact{id="${first.id}" version="${first.revision}"}`,
      `::page{id="${first.id}" revision="${first.revision}"}`,
      `::page{id="${first.id}"}`,
    ].join("\n");

    expect(parseArtifactDirectives(text)).toEqual([{ kind: "text", text }]);
  });

  it("does not parse directives inside fenced code blocks", () => {
    const text = [
      "```text",
      pageDirective(first),
      "```",
      "~~~",
      directive(second),
      "~~~",
      directive(first),
    ].join("\n");

    expect(references(text)).toEqual([first]);
  });

  it("builds the Pages library deep link", () => {
    expect(pageHref(first)).toBe(`/plugins/pages/pages?page=${first.id}`);
  });
});
