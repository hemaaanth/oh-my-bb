import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import { Button } from "@/components/ui/button";
import { ErrorMessage, message } from "../shared/ui";
import {
  formatFileSize,
  formatRelativeTime,
  mapChannelArtifactsToRows,
  mapChannelFilesToRows,
  type ChannelOutputRow,
} from "./channel-output";
import { useChannelRefresh } from "./use-channel";


export function OutputPanel({ id }: { id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const request = useRef(0);
  const [rows, setRows] = useState<ChannelOutputRow[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async (before?: string) => {
    const sequence = ++request.current;
    setPending(true);
    try {
      const [page, artifactReferences] = await Promise.all([
        rpc.call("channelFiles", {
          id,
          ...(before ? { before } : {}),
        }),
        before ? Promise.resolve(null) : rpc.call("channelArtifactReferences", { id }),
      ]);
      const artifactSummaries = artifactReferences?.length
        ? await rpc.call("artifactSummaries", {
            references: artifactReferences.map(({ id: artifactId, revision }) => ({
              id: artifactId,
              revision,
            })),
          })
        : [];
      if (sequence !== request.current) return;
      const nextRows: ChannelOutputRow[] = [
        ...mapChannelFilesToRows(page.files),
        ...(artifactReferences
          ? mapChannelArtifactsToRows(artifactReferences, artifactSummaries)
          : []),
      ];
      setRows((current) =>
        (before ? [...(current ?? []), ...nextRows] : nextRows)
          .sort((left, right) => right.createdAt - left.createdAt)
      );
      setNextBefore(page.nextBefore);
    } catch (cause) {
      if (sequence === request.current) setError(message(cause));
    } finally {
      if (sequence === request.current) setPending(false);
    }
  }, [id, rpc]);

  useEffect(() => {
    setRows(null);
    setNextBefore(null);
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);
  useChannelRefresh(id, () => void load());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const jump = (messageId: string | null) => {
    if (!messageId) return;
    navigate.toPluginPanel("channels", {
      subPath: `${id}/message/${messageId}`,
    });
  };

  return (
    <div className="p-3">
      <ErrorMessage error={error} />
      {rows === null ? (
        <div role="status" className="rounded-md border border-border bg-surface-recessed/70 px-3 py-10 text-center text-sm text-muted-foreground">
          Loading output…
        </div>
      ) : rows.length ? (
        <div className="overflow-hidden rounded-md border border-border bg-background">
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={`${row.kind}:${row.id}`} className="flex min-w-0 gap-3 p-3">
                {row.kind === "file" && row.thumbnailUrl ? (
                  <a href={row.downloadUrl} download={row.name} className="size-12 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                    <img className="size-full object-cover" src={row.thumbnailUrl} alt="" loading="lazy" />
                  </a>
                ) : (
                  <span className="grid size-12 shrink-0 place-items-center rounded-md border border-border bg-surface-recessed text-muted-foreground" aria-hidden>
                    <Icon name={row.kind === "file" ? "Paperclip" : "FileText"} className="size-5" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {row.kind === "file" ? (
                    <a className="block truncate text-sm font-medium text-foreground hover:underline" href={row.downloadUrl} download={row.name} title={row.name}>
                      {row.name}
                    </a>
                  ) : (
                    <a className="block truncate text-sm font-medium text-foreground hover:underline" href={row.href} title={row.name}>
                      {row.name}
                    </a>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.kind === "file" ? `${formatFileSize(row.sizeBytes)} · ` : ""}
                    {row.publisher} · {formatRelativeTime(row.createdAt, now)}
                  </p>
                  {row.messageId ? (
                    <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs" onClick={() => jump(row.messageId)}>
                      Jump to message
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {nextBefore ? (
            <div className="border-t border-border p-2 text-center">
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => void load(nextBefore)}>
                {pending ? "Loading…" : "Load older output"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-md border border-border bg-surface-recessed/70 px-6 py-12 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
            <Icon name="Paperclip" className="size-4" />
          </span>
          <h2 className="mt-3 text-sm font-medium text-foreground">No output yet</h2>
          <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
            Files, images, and reports published by channel agents appear here.
          </p>
        </div>
      )}
    </div>
  );
}
