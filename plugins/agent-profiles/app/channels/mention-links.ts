import type { ChannelAgent } from "../../server/channels/contract";

export const AGENT_MENTION_HREF_PREFIX = "/plugins/agent-profiles/agents/";

const FENCE = /^(\s*)(```|~~~)/u;
// @handle at a word start, not inside a link, path, or email.
const MENTION = /(^|[^\w@/[(.-])@([a-z0-9][a-z0-9-]*)/giu;

const escapeLabel = (text: string) => text.replace(/[[\]\\]/gu, "\\$&");

function linkLine(line: string, byHandle: Map<string, ChannelAgent>) {
  // Leave inline code spans untouched.
  return line
    .split(/(`[^`]*`)/u)
    .map((part) =>
      part.startsWith("`")
        ? part
        : part.replace(MENTION, (match, lead: string, handle: string) => {
            const agent = byHandle.get(handle.toLowerCase());
            if (!agent) return match;
            const label = `${agent.avatar ? `${agent.avatar} ` : ""}${agent.name}`;
            return `${lead}[${escapeLabel(label)}](${AGENT_MENTION_HREF_PREFIX}${agent.id})`;
          }),
    )
    .join("");
}

/** Turn @handles of known agents into links that render as mention pills. */
export function linkAgentMentions(text: string, agents: readonly ChannelAgent[]) {
  if (!text.includes("@") || !agents.length) return text;
  const byHandle = new Map(
    agents.map((agent) => [agent.handle.replace(/^@/u, "").toLowerCase(), agent]),
  );
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : linkLine(line, byHandle);
    })
    .join("\n");
}
