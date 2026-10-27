import type { ChannelAgent } from "../../server/channels/contract";
import { linkAgentMentions } from "./mention-links";
import { useEffect, useMemo, useState } from "react";
import {
  Markdown,
  experimental_Icon as Icon,
  useRpc,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import {
  pageHref,
  parseArtifactDirectives,
  type ArtifactReference,
} from "../../lib/artifact-directives";

type ArtifactSummaries = PluginRpcResult<(typeof rpcContract)["artifactSummaries"]>;
type ArtifactSummary = ArtifactSummaries[number];

function referenceKey(reference: ArtifactReference) {
  return `${reference.id}:${reference.revision}`;
}

function UnavailableArtifact() {
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-surface-recessed/70 px-3 py-2 text-xs text-muted-foreground">
      <Icon name="FileWarning" className="size-4 shrink-0" />
      <span>Page unavailable</span>
    </div>
  );
}

function ArtifactCard({ summary }: { summary: ArtifactSummary | undefined }) {
  if (!summary) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-surface-recessed/70 px-3 py-2 text-xs text-muted-foreground" role="status">
        <Icon name="Files" className="size-4 shrink-0" />
        <span>Loading page…</span>
      </div>
    );
  }
  if (!summary.available) return <UnavailableArtifact />;
  const kind = summary.kind === "pr-review" ? "PR review" : "Report";
  return (
    <article className="my-2 flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden>
        <Icon name="FileText" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-medium text-foreground">{summary.title}</h4>
        <p className="truncate text-xs text-muted-foreground">
          {kind} · v{summary.sequence} ·{" "}
          <time dateTime={summary.revisionCreatedAt}>
            {new Date(summary.revisionCreatedAt).toLocaleString()}
          </time>
        </p>
      </div>
      <a
        className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href={pageHref(summary)}
      >
        Open
      </a>
    </article>
  );
}

const NO_AGENTS: readonly ChannelAgent[] = [];

export function ChannelMessageContent({ text: source, agents = NO_AGENTS }: { text: string; agents?: readonly ChannelAgent[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const text = useMemo(() => linkAgentMentions(source, agents), [source, agents]);
  const segments = useMemo(() => parseArtifactDirectives(text), [text]);
  const references = useMemo(() => {
    const seen = new Set<string>();
    return segments.flatMap((segment) => {
      if (segment.kind !== "artifact") return [];
      const key = referenceKey(segment.reference);
      if (seen.has(key)) return [];
      seen.add(key);
      return [segment.reference];
    });
  }, [segments]);
  const [summaries, setSummaries] = useState<Map<string, ArtifactSummary>>(new Map());

  useEffect(() => {
    let active = true;
    setSummaries(new Map());
    if (!references.length) return () => { active = false; };
    void rpc.call("artifactSummaries", { references }).then(
      (loaded) => {
        if (active) setSummaries(new Map(loaded.map((summary) => [referenceKey(summary), summary])));
      },
      () => {
        if (!active) return;
        setSummaries(new Map(references.map((reference) => [
          referenceKey(reference),
          { ...reference, available: false as const },
        ])));
      },
    );
    return () => { active = false; };
  }, [references, rpc]);

  if (!references.length) return <Markdown className="channel-mentions text-sm leading-relaxed" content={text} />;
  return segments.map((segment, index) => segment.kind === "text" ? (
    segment.text ? <Markdown key={`text:${index}`} className="channel-mentions text-sm leading-relaxed" content={segment.text} /> : null
  ) : (
    <ArtifactCard key={`${referenceKey(segment.reference)}:${index}`} summary={summaries.get(referenceKey(segment.reference))} />
  ));
}
