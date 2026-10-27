import { useCallback, useEffect, useId, useRef, useState } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { Profile, rpcContract } from "../../server/contract";
import { Button } from "@/components/ui/button";
import { documentDraft, readConfigDraft, writeConfigDraft } from "./config-draft";
import { MarkdownEditor } from "./markdown-editor";
import { RevisionList, type Revision } from "./revision-list";
import { ErrorMessage, message } from "../shared/ui";
import { Modal } from "../shared/modal";

export function DocumentEditor({ profile, file }: { profile: Profile; file: "MISSION.md" | "PERSONA.md" }) {
  const rpc = useRpc<typeof rpcContract>();
  const editorId = useId();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const historyBusy = useRef(false);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyPending, setHistoryPending] = useState(false);
  const draftKey = `bb:agents:document:${profile.id}:${file}`;
  const [restored] = useState(() => readConfigDraft(draftKey, documentDraft));
  const initialLoad = useRef(true);
  const [remoteConflict, setRemoteConflict] = useState(false);
  const [operation, setOperation] = useState("Loading…");
  const [doc, setDoc] = useState<{ text: string; version: string } | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reloading, setReloading] = useState(false);
  const dirty = !!doc && text !== doc.text;
  const limit = file === "PERSONA.md" ? 32_000 : 64_000;
  const tooLong = text.length > limit;

  const loadHistory = async (before?: number) => {
    if (historyBusy.current) return;
    historyBusy.current = true;
    setHistoryPending(true);
    try {
      const page = await rpc.call("documentHistory", {
        id: profile.id,
        file,
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

  const load = useCallback(() => {
    setPending(true);
    setOperation("Loading…");
    rpc.call("agentDocument", { id: profile.id, file }).then(
      (nextDocument) => {
        const draft = initialLoad.current ? restored : null;
        initialLoad.current = false;
        setRemoteConflict(!!draft && draft.doc.version !== nextDocument.version);
        setDoc(draft?.doc ?? nextDocument);
        setText(draft?.text ?? nextDocument.text);
        setError(
          draft && draft.doc.version !== nextDocument.version
            ? "This file changed while you were away. Your draft is preserved; copy your edits before reloading the latest file."
            : null,
        );
        setSaved(false);
      },
      (cause) => setError(message(cause)),
    ).finally(() => setPending(false));
  }, [file, profile.id, restored, rpc]);

  useEffect(load, [load]);
  useEffect(() => {
    if (!doc) return;
    try {
      writeConfigDraft(draftKey, dirty ? { text, doc } : null);
    } catch {
      setError("Draft could not be saved on this device. Save your changes before leaving.");
    }
  }, [doc, draftKey, dirty, text]);

  const save = async () => {
    if (!doc || pending || !dirty || remoteConflict || tooLong) return;
    setPending(true);
    setOperation("Saving…");
    try {
      const nextDocument = await rpc.call("saveAgentDocument", {
        id: profile.id,
        file,
        text,
        version: doc.version,
      });
      setDoc(nextDocument);
      setText(nextDocument.text);
      setError(null);
      setSaved(true);
      setRemoteConflict(false);
      setRevisions(null);
    } catch (cause) {
      if (message(cause).includes("document changed")) setRemoteConflict(true);
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="bot-document">
      <div>
        <h2 className="text-sm font-medium text-foreground">
          {file === "MISSION.md" ? "Mission" : "Persona"}
        </h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {file === "MISSION.md"
            ? "The standing direction this agent reads at the start of every turn."
            : "Who this agent is and how it works. The agent can update this itself; every change is listed below with who made it."}
        </p>
      </div>
      {doc ? (
        <MarkdownEditor
          id={editorId}
          label={file}
          value={text}
          disabled={pending}
          onSave={() => void save()}
          onChange={(value) => {
            setText(value);
            setSaved(false);
          }}
        />
      ) : (
        <div role="status" className="rounded-md border border-border bg-surface-recessed/70 px-3 py-10 text-center text-sm text-muted-foreground">
          Loading {file}…
        </div>
      )}
      <ErrorMessage
        error={tooLong
          ? `This file exceeds ${limit.toLocaleString("en-US")} characters. Shorten it before saving; your draft is preserved.`
          : error}
      />
      <div className="bot-document-actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (dirty) setReloading(true);
            else load();
          }}
        >
          <Icon name="RotateCcw" /> Reload file
        </Button>
        <span role="status" className="bot-document-status text-xs text-muted-foreground">
          {pending ? operation : dirty ? "Unsaved changes · draft saved" : saved ? "Saved" : ""}
        </span>
        <Button size="sm" disabled={!doc || pending || !dirty || remoteConflict || tooLong} onClick={save}>
          Save {file === "MISSION.md" ? "mission" : "persona"}
        </Button>
      </div>
      <section className="space-y-3 border-t border-border/80 pt-6">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Version history</h2>
          <Button size="sm" variant="outline" disabled={historyPending} onClick={() => void loadHistory()}>
            {historyPending ? "Loading…" : revisions ? "Refresh" : "View history"}
          </Button>
        </div>
        {revisions ? (
          <RevisionList
            revisions={revisions}
            current={text}
            morePending={historyPending}
            onMore={historyMore ? () => void loadHistory(revisions.at(-1)!.id) : undefined}
            onUse={(value) => {
              if (pending) return;
              setText(value);
              setSaved(false);
            }}
          />
        ) : null}
      </section>
      <Modal title="Discard unsaved changes?" open={reloading} onOpenChange={setReloading}>
        <p className="text-sm leading-5">Reloading {file} replaces your unsaved edits with the latest file.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button autoFocus size="sm" variant="ghost" onClick={() => setReloading(false)}>Keep editing</Button>
          <Button
            size="sm"
            onClick={() => {
              setReloading(false);
              load();
            }}
          >
            Discard and reload
          </Button>
        </div>
      </Modal>
    </div>
  );
}
