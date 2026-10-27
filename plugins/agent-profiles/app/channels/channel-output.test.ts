import { describe, expect, it } from "vitest";
import type { ChannelFileEntry } from "../../server/channels/contract";
import { mapChannelArtifactsToRows, mapChannelFilesToRows } from "./channel-output";

const roomId = "00000000-0000-4000-8000-000000000001";

function entry(
  id: string,
  name: string,
  type: "localFile" | "localImage",
  createdAt: number,
): ChannelFileEntry {
  return {
    attachment: {
      id,
      roomId,
      projectId: "project-1",
      name,
      path: `/tmp/${name}`,
      mimeType: type === "localImage" ? "image/png" : "text/csv",
      type,
      sizeBytes: 512,
    },
    messageId: `message-${id}`,
    agentId: "00000000-0000-4000-8000-000000000002",
    publisher: "Atlas",
    createdAt,
  };
}

describe("channel Output rows", () => {
  it("preserves newest-first files and maps publication metadata", () => {
    const image = entry(
      "00000000-0000-4000-8000-000000000010",
      "preview.png",
      "localImage",
      200,
    );
    const csv = entry(
      "00000000-0000-4000-8000-000000000011",
      "report.csv",
      "localFile",
      100,
    );

    const rows = mapChannelFilesToRows([image, csv]);

    expect(rows.map((row) => row.name)).toEqual(["preview.png", "report.csv"]);
    expect(rows[0]).toMatchObject({
      kind: "file",
      publisher: "Atlas",
      createdAt: 200,
      messageId: `message-${image.attachment.id}`,
      thumbnailUrl: expect.stringContaining("inline=1"),
    });
    expect(rows[1]).toMatchObject({
      downloadUrl: expect.stringContaining(csv.attachment.id),
      thumbnailUrl: null,
    });
  });

  it("maps channel page references to report rows and library links", () => {
    const reference = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      revision: "123e4567-e89b-42d3-a456-426614174001",
      messageId: "message-report",
      publisher: "Atlas",
      createdAt: 300,
    };

    expect(mapChannelArtifactsToRows([reference], [{
      id: reference.id,
      revision: reference.revision,
      available: true,
      title: "Release chart",
      kind: "report",
      sequence: 1,
      revisionCreatedAt: "2026-09-23T12:00:00.000Z",
    }])).toEqual([{
      kind: "artifact",
      id: `${reference.id}:${reference.revision}`,
      name: "Release chart",
      publisher: "Atlas",
      createdAt: 300,
      messageId: "message-report",
      href: `/plugins/pages/pages?page=${reference.id}`,
    }]);
  });
});
