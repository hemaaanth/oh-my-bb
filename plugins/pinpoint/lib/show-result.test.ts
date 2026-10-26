import { describe, expect, it } from "vitest";

import { buildShowResult } from "./show-result";

describe("pinpoint_show tool result", () => {
  it("returns image content parts for stored screenshots after the text", () => {
    const result = buildShowResult("annotation context", [
      { kind: "element", mime: "image/webp", data: "ZWxlbWVudA==" },
      { kind: "viewport", mime: "image/png", data: "dmlld3BvcnQ=" },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "annotation context" },
      { type: "image", data: "ZWxlbWVudA==", mimeType: "image/webp" },
      { type: "image", data: "dmlld3BvcnQ=", mimeType: "image/png" },
    ]);
  });

  it("returns text-only content when no screenshot is stored", () => {
    const result = buildShowResult("annotation context", []);
    expect(result.content).toEqual([
      { type: "text", text: "annotation context" },
    ]);
  });
});
