import { useState } from "react";
import { Button } from "@/components/ui/button";

export type Revision = {
  id: number;
  text: string;
  actor: string;
  createdAt: number;
};

/** A valid replacement diff, bounded by the document size, without quadratic LCS. */
export function revisionDiff(previous: string, current: string) {
  const before = previous.split("\n");
  const after = current.split("\n");
  let start = 0;
  let end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end += 1;
  return [
    ...before.slice(Math.max(0, start - 2), start).map((line) => `  ${line}`),
    ...before.slice(start, before.length - end).map((line) => `− ${line}`),
    ...after.slice(start, after.length - end).map((line) => `+ ${line}`),
    ...before.slice(before.length - end, before.length - end + 2).map((line) => `  ${line}`),
  ].join("\n") || "No changes";
}

export function RevisionList({
  revisions,
  current,
  onUse,
  onMore,
  morePending,
}: {
  revisions: Revision[];
  current: string;
  onUse: (text: string) => void;
  onMore?: () => void;
  morePending?: boolean;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div className="channel-revisions">
      {!revisions.length ? <p>No saved versions yet.</p> : null}
      {revisions.map((revision) => (
        <details
          key={revision.id}
          open={selected === revision.id}
          onToggle={(event) => {
            if (event.currentTarget.open) setSelected(revision.id);
          }}
        >
          <summary>{new Date(revision.createdAt).toLocaleString()} · {revision.actor}</summary>
          <pre aria-label="Version compared with current draft">{revisionDiff(revision.text, current)}</pre>
          <Button size="sm" variant="outline" onClick={() => onUse(revision.text)}>Use this version</Button>
        </details>
      ))}
      {onMore ? (
        <Button variant="ghost" size="sm" disabled={morePending} onClick={onMore}>Earlier versions</Button>
      ) : null}
    </div>
  );
}
