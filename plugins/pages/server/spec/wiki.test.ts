import { describe, expect, it } from "vitest";
import { leadFile, pickWikiPhoto } from "./wiki.js";

const lead = { file: "Palace.jpg", articleUrl: "https://en.wikipedia.org/wiki/Palace" };
const info = { title: "File:Palace.jpg", imageinfo: [{ url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Palace.jpg", thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Palace.jpg/500px-Palace.jpg", thumbwidth: 500, thumbheight: 333, mime: "image/jpeg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Palace.jpg", extmetadata: { Artist: { value: "<a>Ann &amp; Bo</a>" }, LicenseShortName: { value: "CC BY 2.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by/2.0" } } }] };

describe("credited Wikipedia lead photos", () => {
  it("does not substitute a local-wiki or unrelated thumbnail for a reusable Commons original", () => {
    const base = { originalimage: { source: info.imageinfo[0]!.url }, thumbnail: { source: info.imageinfo[0]!.thumburl }, content_urls: { desktop: { page: lead.articleUrl } } };
    expect(leadFile(base)).toEqual(lead);
    expect(leadFile({ ...base, thumbnail: { source: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Other.jpg" } })).toBeNull();
    expect(leadFile({ ...base, originalimage: { source: "https://upload.wikimedia.org/wikipedia/en/a/ab/Palace.jpg" } })).toBeNull();
    expect(leadFile({ ...base, type: "disambiguation" })).toBeNull();
  });

  it("retains the author, free license, article, and exact image identity", () => {
    expect(pickWikiPhoto({ query: { pages: [info] } }, lead)).toMatchObject({ creator: "Ann & Bo", license: "CC BY 2.0", articleUrl: lead.articleUrl, sourceUrl: "https://commons.wikimedia.org/wiki/File:Palace.jpg", width: 500, height: 333 });
    expect(pickWikiPhoto({ query: { pages: [{ ...info, title: "File:Other.jpg" }] } }, lead)).toBeNull();
  });

  it("refuses a photograph that cannot be credited or reused", () => {
    for (const extmetadata of [{ Artist: { value: "Ann" }, LicenseShortName: { value: "All rights reserved" } }, { LicenseShortName: { value: "CC BY 2.0" } }]) {
      expect(pickWikiPhoto({ query: { pages: [{ ...info, imageinfo: [{ ...info.imageinfo[0], extmetadata }] }] } }, lead)).toBeNull();
    }
  });
});
