import { describe, expect, it } from "vitest";
import { channelMessageIdFromSubPath } from "./channel-path";

const roomId = "1539267d-304c-42bb-8665-be2c7b1ed97d";
const messageId = "request-id:agent-id";

describe("channel message paths", () => {
  it("accepts host-encoded and caller-plus-host-encoded message IDs", () => {
    expect(
      channelMessageIdFromSubPath(`${roomId}/message/request-id%3Aagent-id`),
    ).toBe(messageId);
    expect(
      channelMessageIdFromSubPath(`${roomId}/message/request-id%253Aagent-id`),
    ).toBe(messageId);
  });
});
