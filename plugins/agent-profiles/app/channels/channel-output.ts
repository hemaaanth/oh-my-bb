import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import type {
  Attachment,
  ChannelFileEntry,
} from "../../server/channels/contract";
import { inlineImage } from "../shared/image-format";
import { pageHref } from "../../lib/artifact-directives";

type ArtifactSummaries = PluginRpcResult<(typeof rpcContract)["artifactSummaries"]>;
type ChannelArtifactReferences = PluginRpcResult<(typeof rpcContract)["channelArtifactReferences"]>;

export type FileOutputRow = {
  kind: "file";
  id: string;
  name: string;
  sizeBytes: number;
  publisher: string;
  createdAt: number;
  messageId: string;
  attachment: Attachment;
  downloadUrl: string;
  thumbnailUrl: string | null;
};

/** P5-T4 can append artifact records without changing the panel's shared row fields. */
export type ArtifactOutputRow = {
  kind: "artifact";
  id: string;
  name: string;
  publisher: string;
  createdAt: number;
  messageId: string | null;
  href: string;
};

export type ChannelOutputRow = FileOutputRow | ArtifactOutputRow;

const attachmentUrl = (id: string, inline = false) =>
  `/api/v1/plugins/agent-profiles/http/attachment?id=${encodeURIComponent(id)}${inline ? "&inline=1" : ""}`;

export function mapChannelFilesToRows(
  entries: ChannelFileEntry[],
): FileOutputRow[] {
  return entries.map((entry) => ({
    kind: "file",
    id: entry.attachment.id,
    name: entry.attachment.name,
    sizeBytes: entry.attachment.sizeBytes,
    publisher: entry.publisher,
    createdAt: entry.createdAt,
    messageId: entry.messageId,
    attachment: entry.attachment,
    downloadUrl: attachmentUrl(entry.attachment.id),
    thumbnailUrl: inlineImage(entry.attachment)
      ? attachmentUrl(entry.attachment.id, true)
      : null,
  }));
}

export function mapChannelArtifactsToRows(
  references: ChannelArtifactReferences,
  summaries: ArtifactSummaries,
): ArtifactOutputRow[] {
  const summaryByReference = new Map(
    summaries.map((summary) => [
      `${summary.id}:${summary.revision}`,
      summary,
    ]),
  );
  return references.map((reference) => {
    const summary = summaryByReference.get(
      `${reference.id}:${reference.revision}`,
    );
    return {
      kind: "artifact",
      id: `${reference.id}:${reference.revision}`,
      name: summary?.available ? summary.title : "Page unavailable",
      publisher: reference.publisher,
      createdAt: reference.createdAt,
      messageId: reference.messageId,
      href: pageHref(reference),
    };
  });
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()) {
  const seconds = Math.round((timestamp - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
