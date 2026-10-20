// Agent (SPEC §12.3): name, voice, the owner's instructions, a read-only look at
// the assembled prompt, and the revision history.
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import { AGENT_NAME_MAX, CHANNELS, INSTRUCTIONS_LIMIT, VOICES } from "../../shared/constants.js";
import type { InstructionRevision, PromptParts, RpcContract } from "../../shared/contract.js";
import { firstLine, formatDateTime } from "../console/format.js";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { errorText, useLatest, usePreferences } from "./data.js";
import { Group, Loading, Note, Row, selectClass } from "./layout.js";

function NameRow({ saved, save }: { saved: string; save: (name: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(saved);
  // Follow a new saved name during render. A mount effect here could land
  // after the first keystroke and wipe it.
  const [shownSaved, setShownSaved] = useState(saved);
  if (saved !== shownSaved) {
    setShownSaved(saved);
    setDraft(saved);
  }

  const commit = async () => {
    const next = draft.trim();
    if (next === "" || next === saved) return setDraft(saved);
    if (!(await save(next))) setDraft(saved);
  };

  return (
    <Row label="Name" htmlFor="dispatch-agent-name" help="Say this name to wake the agent.">
      <Input
        id="dispatch-agent-name"
        value={draft}
        maxLength={AGENT_NAME_MAX}
        className="sm:w-56"
        onChange={(event) => setDraft(event.target.value.slice(0, AGENT_NAME_MAX))}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(saved);
        }}
      />
      <Note>
        Say “{draft.trim() || saved}, …”
        <span className="ml-2 tabular-nums">
          {draft.length}/{AGENT_NAME_MAX}
        </span>
      </Note>
    </Row>
  );
}

function PartBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h5 className="text-xs font-medium text-foreground">{title}</h5>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-state-hover p-2 text-xs leading-5 text-muted-foreground">{text || "(empty)"}</pre>
    </div>
  );
}

function PromptLayer({ title, parts }: { title: string; parts: PromptParts }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <PartBlock title="Built in" text={parts.builtIn} />
      <PartBlock title="Runtime context (sample)" text={parts.runtime} />
      <PartBlock title="Your instructions" text={parts.yours} />
    </section>
  );
}

function PromptPreview() {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ voice: PromptParts; backend: PromptParts } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    rpcRef.current
      .call("promptPreview", {})
      .then((value) => active && setPreview(value))
      .catch((cause: unknown) => active && setError(errorText(cause)));
    return () => {
      active = false;
    };
  }, [open, rpcRef]);

  return (
    <div className="flex flex-col gap-2 py-3">
      <Button variant="outline" size="sm" className="self-start" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide full prompt" : "Show full prompt"}
      </Button>
      {open && !preview ? <Loading error={error} /> : null}
      {open && preview ? (
        <div className="flex flex-col gap-4">
          <Note>Read-only. The built-in part stays in place. Your instructions are added after it.</Note>
          <PromptLayer title="Voice prompt" parts={preview.voice} />
          <PromptLayer title="Backend prompt" parts={preview.backend} />
        </div>
      ) : null}
    </div>
  );
}

function InstructionsEditor() {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<InstructionRevision[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedRef = useLatest(saved);
  const draftRef = useLatest(draft);

  /** Take a revision as the saved text. An untouched draft follows it. */
  const adopt = useCallback(
    (revision: InstructionRevision | null) => {
      const body = revision?.body ?? "";
      if (draftRef.current === (savedRef.current ?? "")) setDraft(body);
      setSaved(body);
    },
    [draftRef, savedRef],
  );

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await rpcRef.current.call("instructionsHistory", { limit: 50 })).revisions);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [rpcRef]);

  useEffect(() => {
    let active = true;
    rpcRef.current
      .call("instructionsRead", {})
      .then(({ current }) => {
        if (!active) return;
        setSaved(current?.body ?? "");
        setDraft(current?.body ?? "");
      })
      .catch((cause: unknown) => active && setError(errorText(cause)));
    void loadHistory();
    return () => {
      active = false;
    };
  }, [rpcRef, loadHistory]);

  useRealtime(CHANNELS.instructionsUpdated, (payload) => {
    adopt(payload as InstructionRevision);
    void loadHistory();
  });

  if (saved === null) return <Loading error={error} />;

  const dirty = draft !== saved;
  const over = draft.length > INSTRUCTIONS_LIMIT;

  const run = async (action: () => Promise<InstructionRevision>) => {
    setBusy(true);
    setError(null);
    try {
      const revision = await action();
      setSaved(revision.body);
      setDraft(revision.body);
      await loadHistory();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2 py-3">
        <label htmlFor="dispatch-instructions" className="text-sm font-medium text-foreground">
          Your instructions
        </label>
        <Note>The built-in prompt stays in place. This text is added after it.</Note>
        <Textarea id="dispatch-instructions" rows={8} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <div className="flex items-center justify-between gap-2">
          <span className={over ? "text-xs text-destructive" : "text-xs text-muted-foreground"} aria-live="polite">
            {draft.length.toLocaleString("en-US")} / {INSTRUCTIONS_LIMIT.toLocaleString("en-US")}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!dirty || busy} onClick={() => setDraft(saved)}>
              Revert
            </Button>
            <Button size="sm" disabled={!dirty || over || busy} onClick={() => void run(() => rpcRef.current.call("instructionsWrite", { body: draft }))}>
              Save
            </Button>
          </div>
        </div>
        {error ? <Note tone="error">{error}</Note> : null}
      </div>
      <PromptPreview />
      <div className="flex flex-col gap-1 py-3">
        <h4 className="text-sm font-medium text-foreground">History</h4>
        {history.length === 0 ? <Note>No saved versions yet.</Note> : null}
        <ul className="flex flex-col">
          {history.map((revision) => (
            <li key={revision.id} className="flex items-center gap-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{formatDateTime(revision.at)}</span>
                  <Badge variant="secondary">{revision.author}</Badge>
                  {revision.note ? <span className="truncate text-xs text-muted-foreground">{revision.note}</span> : null}
                </div>
                <span className="truncate text-sm text-foreground">{firstLine(revision.body) || "(empty)"}</span>
              </div>
              <Button variant="ghost" size="sm" disabled={busy || revision.body === saved} onClick={() => void run(() => rpcRef.current.call("instructionsRestore", { id: revision.id }))}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export function AgentSection() {
  const { prefs, error, save } = usePreferences();
  if (!prefs) return <Loading error={error} />;
  const voices = VOICES.includes(prefs.voice as (typeof VOICES)[number]) ? [...VOICES] : [prefs.voice, ...VOICES];
  return (
    <Group>
      <NameRow saved={prefs.agentName} save={(agentName) => save({ agentName })} />
      <Row label="Voice" htmlFor="dispatch-voice">
        <select id="dispatch-voice" className={selectClass} value={prefs.voice} onChange={(event) => void save({ voice: event.target.value })}>
          {voices.map((voice) => (
            <option key={voice} value={voice}>
              {voice}
            </option>
          ))}
        </select>
      </Row>
      {error ? <Note tone="error">{error}</Note> : null}
      <InstructionsEditor />
    </Group>
  );
}
