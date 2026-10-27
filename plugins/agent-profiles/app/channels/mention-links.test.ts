import { describe, expect, it } from "vitest";
import type { ChannelAgent } from "../../server/channels/contract";
import { linkAgentMentions } from "./mention-links";

const agents = [
  { id: "a1", handle: "text-edit-agent", name: "Text Edit Agent", avatar: "📝" },
  { id: "a2", handle: "@ponytail", name: "Ponytail", avatar: "" },
] as unknown as ChannelAgent[];

describe("linkAgentMentions", () => {
  it("links known handles as agent pills", () => {
    expect(linkAgentMentions("@text-edit-agent fix it, cc @ponytail.", agents)).toBe(
      "[📝 Text Edit Agent](/plugins/agent-profiles/agents/a1) fix it, cc [Ponytail](/plugins/agent-profiles/agents/a2).",
    );
  });

  it("leaves unknown handles, emails, code, and fences alone", () => {
    const text = "@nobody me@ponytail.dev `@ponytail`\n```\n@ponytail\n```";
    expect(linkAgentMentions(text, agents)).toBe(text);
  });
});
