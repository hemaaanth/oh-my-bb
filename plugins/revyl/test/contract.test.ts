import assert from "node:assert/strict";
import { test } from "node:test";
import { embedUrl, rpcContract } from "../contract.js";

test("only plain Revyl public embed URLs may be configured", () => {
  assert.equal(embedUrl.safeParse("https://app.revyl.ai/embed/abc_123").success, true);
  for (const url of ["https://evil.example/embed/abc", "http://app.revyl.ai/embed/abc", "https://app.revyl.ai.evil.example/embed/abc", "https://app.revyl.ai/embed/abc?mint=secret", "https://app.revyl.ai/embed/abc#fragment", "https://app.revyl.ai/view/abc", "https://app.revyl.ai/embed/abc/extra", "https://user@app.revyl.ai/embed/abc", "not-a-url"]) {
    assert.equal(embedUrl.safeParse(url).success, false, url);
  }
});

test("embed lookup and configuration require thread and platform", () => {
  assert.equal(rpcContract.revyl_embed.input.safeParse({ threadId: "thr_123", platform: "ios" }).success, true);
  assert.equal(rpcContract.revyl_configure.input.safeParse({ threadId: "thr_123", platform: "android", url: "https://app.revyl.ai/embed/abc" }).success, true);
  assert.equal(rpcContract.revyl_configure.input.safeParse({ threadId: "", platform: "android", url: "https://app.revyl.ai/embed/abc" }).success, false);
  assert.equal(rpcContract.revyl_configure.input.safeParse({ threadId: "thr_123", platform: "web", url: "https://app.revyl.ai/embed/abc" }).success, false);
});
