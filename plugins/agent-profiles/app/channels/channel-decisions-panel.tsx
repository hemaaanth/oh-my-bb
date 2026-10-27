import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "../agents/markdown-editor";
import { RevisionList, type Revision } from "../agents/revision-list";
import { ErrorMessage, message, TabBar } from "../shared/ui";
import { useChannelRefresh } from "./use-channel";

type ChannelContext = PluginRpcResult<(typeof rpcContract)["channelContext"]>;
type ContextRevision = PluginRpcResult<(typeof rpcContract)["contextHistory"]>[number];
type ContextField = "brief" | "decisions" | "memory";

const fields: ContextField[] = ["brief", "decisions", "memory"];
const descriptions: Record<ContextField, string> = {
  brief: "Owner instructions for this channel.",
  decisions: "Settled choices that every channel agent should follow.",
  memory: "Channel-specific facts and working context.",
};

const changed = (draft: ChannelContext | null, saved: ChannelContext | null) =>
  !!draft && !!saved && (
    draft.brief !== saved.brief ||
    draft.decisions !== saved.decisions ||
    draft.memory !== saved.memory ||
    JSON.stringify(draft.attachmentIds) !== JSON.stringify(saved.attachmentIds)
  );

const conflictMessage = "Channel context changed. Reload before saving; your draft is preserved.";

function revisionText(revision: ContextRevision, field: ContextField) {
  try {
    const value = JSON.parse(revision.text) as Partial<Record<ContextField, unknown>>;
    return typeof value[field] === "string" ? value[field] : "";
  } catch {
    return "";
  }
}

export function DecisionsPanel({ id }: { id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const editorId = useId();
  const savedRef = useRef<ChannelContext | null>(null);
  const draftRef = useRef<ChannelContext | null>(null);
  const historyBusy = useRef(false);
  const [field, setField] = useState<ContextField>("decisions");
  const [saved, setSaved] = useState<ChannelContext | null>(null);
  const [draft, setDraft] = useState<ChannelContext | null>(null);
  const [revisions, setRevisions] = useState<ContextRevision[] | null>(null);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyPending, setHistoryPending] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [remoteConflict, setRemoteConflict] = useState(false);
  const dirty = changed(draft, saved);

  useEffect(() => {
    savedRef.current = saved;
    draftRef.current = draft;
  }, [draft, saved]);

  const load = useCallback(async (preserveDraft = false) => {
    setPending(true);
    try {
      const next = await rpc.call("channelContext", { id });
      const currentSaved = savedRef.current;
      const currentDraft = draftRef.current;
      if (
        preserveDraft &&
        currentSaved &&
        changed(currentDraft, currentSaved) &&
        next.version !== currentSaved.version
      ) {
        setRemoteConflict(true);
        setError(conflictMessage);
        return;
      }
      savedRef.current = next;
      draftRef.current = next;
      setSaved(next);
      setDraft(next);
      setRemoteConflict(false);
      setError(null);
      if (!preserveDraft || next.version !== currentSaved?.version) setNotice("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  }, [id, rpc]);

  useEffect(() => {
    savedRef.current = null;
    draftRef.current = null;
    setSaved(null);
    setDraft(null);
    setRevisions(null);
    void load();
  }, [load]);
  useChannelRefresh(id, () => void load(true));

  const save = async () => {
    if (!saved || !draft || pending || !dirty || remoteConflict) return;
    setPending(true);
    setError(null);
    setNotice("");
    try {
      const next = await rpc.call("saveChannelContext", {
        id,
        version: saved.version,
        brief: draft.brief,
        decisions: draft.decisions,
        memory: draft.memory,
        attachmentIds: draft.attachmentIds,
      });
      savedRef.current = next;
      draftRef.current = next;
      setSaved(next);
      setDraft(next);
      setRemoteConflict(false);
      setRevisions(null);
      setNotice("Channel context saved.");
    } catch (cause) {
      const detail = message(cause);
      if (detail.includes("Channel context changed")) {
        setRemoteConflict(true);
        setError(conflictMessage);
      } else {
        setError(detail);
      }
    } finally {
      setPending(false);
    }
  };

  const loadHistory = async (before?: number) => {
    if (historyBusy.current) return;
    historyBusy.current = true;
    setHistoryPending(true);
    try {
      const page = await rpc.call("contextHistory", {
        id,
        ...(before !== undefined ? { before } : {}),
      });
      setRevisions((current) => before ? [...(current ?? []), ...page] : page);
      setHistoryMore(page.length === 20);
    } catch (cause) {
      setError(message(cause));
    } finally {
      historyBusy.current = false;
      setHistoryPending(false);
    }
  };

  const visibleRevisions: Revision[] = (revisions ?? []).map((revision) => ({
    ...revision,
    text: revisionText(revision, field),
  }));

  return (
    <div className="bot-document p-3">
      <div>
        <h2 className="text-sm font-medium text-foreground">Channel context</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Brief, decisions, and memory are injected into every channel agent turn.
        </p>
      </div>
      <TabBar
        items={fields}
        selected={field}
        label="Channel context section"
        onSelect={(next) => {
          setField(next as ContextField);
          setRevisions(null);
        }}
      />
      <p className="text-xs leading-5 text-muted-foreground">{descriptions[field]}</p>
      {draft ? (
        <MarkdownEditor
          id={editorId}
          label={field[0]!.toUpperCase() + field.slice(1)}
          value={draft[field]}
          disabled={pending}
          onSave={() => void save()}
          onChange={(value) => {
            const next = { ...draft, [field]: value };
            draftRef.current = next;
            setDraft(next);
            setNotice("");
          }}
        />
      ) : (
        <div role="status" className="rounded-md border border-border bg-surface-recessed/70 px-3 py-10 text-center text-sm text-muted-foreground">
          Loading channel context…
        </div>
      )}
      {remoteConflict ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm text-destructive">{error}</p>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void load()}>
            Reload
          </Button>
        </div>
      ) : (
        <ErrorMessage error={error} />
      )}
      <div className="bot-document-actions">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => void load()}>
          Reload
        </Button>
        <span role="status" className="bot-document-status text-xs text-muted-foreground">
          {pending ? "Saving…" : dirty ? "Unsaved changes" : notice}
        </span>
        <Button size="sm" disabled={!saved || !draft || pending || !dirty || remoteConflict} onClick={() => void save()}>
          Save context
        </Button>
      </div>
      <section className="space-y-3 border-t border-border/80 pt-5">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{field[0]!.toUpperCase() + field.slice(1)} history</h2>
          <Button size="sm" variant="outline" disabled={historyPending} onClick={() => void loadHistory()}>
            {historyPending ? "Loading…" : revisions ? "Refresh" : "View history"}
          </Button>
        </div>
        {revisions ? (
          <RevisionList
            revisions={visibleRevisions}
            current={draft?.[field] ?? ""}
            morePending={historyPending}
            onMore={historyMore ? () => void loadHistory(revisions.at(-1)!.id) : undefined}
            onUse={(text) => {
              if (!draft || pending) return;
              const next = { ...draft, [field]: text };
              draftRef.current = next;
              setDraft(next);
              setNotice("");
            }}
          />
        ) : null}
      </section>
    </div>
  );
}
