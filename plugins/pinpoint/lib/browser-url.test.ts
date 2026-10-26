import { describe, expect, it } from "vitest";
import {
  firstViewableUrl,
  normalizeBrowserUrl,
  samePage,
} from "./browser-url";

describe("Pinpoint browser URLs", () => {
  it("extracts a Markdown destination without swallowing ](", () => {
    const url = "https://preview.example.test";
    expect(firstViewableUrl(`[${url}](${url})`)).toBe(url);
  });

  it("normalizes a pasted Markdown link before loading it", () => {
    expect(normalizeBrowserUrl("[Preview](https://example.com/work?q=1)"))
      .toBe("https://example.com/work?q=1");
  });

  it("keeps localhost on HTTP", () => {
    expect(normalizeBrowserUrl("localhost:3000/demo"))
      .toBe("http://localhost:3000/demo");
  });

  it("scopes annotations by path and query but not section hash", () => {
    expect(samePage("https://example.com/a#one", "https://example.com/a#two"))
      .toBe(true);
    expect(samePage("https://example.com/a?tab=one", "https://example.com/a?tab=two"))
      .toBe(false);
    expect(samePage("https://example.com/a", "https://example.com/b"))
      .toBe(false);
  });
});
