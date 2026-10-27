import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  ChannelAgent,
  Job,
  RoomMessage,
} from "../../server/channels/contract";
import type { rpcContract } from "../../server/contract";
import { Button } from "@/components/ui/button";
import { AgentOptions, matchingAgents } from "../shared/channel-controls";
import { ChannelAttachments } from "../shared/channel-attachments";
import {
  clearSentDraft,
  emptyDraft,
  prepareSend,
  readDraft,
  type Draft,
} from "../shared/draft";
import {
  parseSendMode,
  sendModeCommandPattern,
  type ParsedSendMode,
} from "../shared/send-mode";

const errorText = (error: unknown) => {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Allow microphone access to dictate a message.";
  }
  return (error instanceof Error ? error.message : String(error)).replace(
    /^(HTTP \d+: )+/,
    "",
  );
};

const encode = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.readAsDataURL(file);
  });

type SendModeFeedback =
  | { kind: "error"; text: string }
  | { kind: "hint"; text: string }
  | null;


function sendModeFeedback({
  draft,
  roomId,
  agents,
  memberIds,
  jobs,
}: {
  draft: Draft;
  roomId: string;
  agents: ChannelAgent[];
  memberIds: string[];
  jobs: Job[];
}): SendModeFeedback {
  if (!sendModeCommandPattern.test(draft.text.trim())) return null;
  let parsed: ParsedSendMode;
  try {
    parsed = parseSendMode(draft.text, draft.sendMode);
  } catch (cause) {
    return { kind: "error", text: errorText(cause) };
  }
  const members = agents.filter(
    (agent) => memberIds.includes(agent.id) && !agent.retired,
  );
  const targetIds = new Set(
    members
      .filter((agent) =>
        new RegExp(
          `(^|[^a-z0-9_-])@${agent.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9_-])`,
          "iu",
        ).test(parsed.text)
      )
      .map((agent) => agent.id),
  );
  if (draft.reply?.agentId && memberIds.includes(draft.reply.agentId))
    targetIds.add(draft.reply.agentId);
  if (!targetIds.size && members.length === 1) targetIds.add(members[0]!.id);
  const primaryKey = `group:${roomId}`;
  const active = members.filter((agent) => {
    if (!targetIds.has(agent.id)) return false;
    const replyKey =
      draft.reply?.agentId === agent.id ? draft.reply.conversationKey : undefined;
    const conversationKey =
      replyKey === primaryKey || replyKey?.startsWith(`${primaryKey}:fork:`)
        ? replyKey
        : primaryKey;
    return jobs.some(
      (job) =>
        job.agentId === agent.id &&
        job.conversationKey === conversationKey &&
        (job.status === "dispatching" || job.status === "running"),
    );
  });
  if (!active.length) {
    const label =
      parsed.mode === "steer"
        ? "Steer"
        : parsed.mode === "fork"
          ? "Answer in parallel"
          : "Queue";
    return {
      kind: "error",
      text: `${label} needs a busy target. Mention an agent with a running turn.`,
    };
  }
  const names = active.map((agent) => `@${agent.handle}`).join(", ");
  return {
    kind: "hint",
    text:
      parsed.mode === "steer"
        ? `Steer ${names}'s current turn`
        : parsed.mode === "fork"
          ? `Answer ${names} in parallel`
          : `Queue after ${names}'s current turn`,
  };
}

export function GroupComposer({
  autoFocus = false,
  roomId,
  roomName,
  paused,
  reply,
  onClearReply,
  onSent,
  agents,
  jobs,
  memberIds,
  onCreateAgent,
  footer,
}: {
  autoFocus?: boolean;
  roomId: string;
  roomName: string;
  paused: boolean;
  reply: RoomMessage | null;
  onClearReply: () => void;
  onSent: () => void;
  agents: ChannelAgent[];
  memberIds: string[];
  jobs: Job[];
  onCreateAgent?: () => void;
  footer?: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const key = `bb:agents:channel-draft:${roomId}`;
  const [draft, setDraftState] = useState(() => readDraft(localStorage, key));
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestDraft = useRef(draft);
  const setDraft = (update: Draft | ((current: Draft) => Draft)) => {
    const next =
      typeof update === "function" ? update(latestDraft.current) : update;
    latestDraft.current = next;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
    setDraftState(next);
  };
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voice, setVoice] = useState<
    "idle" | "starting" | "recording" | "transcribing"
  >("idle");
  const editor = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const recording = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  const sending = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const listId = useId();
  const [mention, setMention] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [selection, setSelection] = useState(0);
  const options = mention
    ? matchingAgents(agents, memberIds, mention.query)
    : [];
  const optionCount = options.length + (onCreateAgent ? 1 : 0);
  const modeFeedback = sendModeFeedback({
    draft,
    roomId,
    agents,
    memberIds,
    jobs,
  });

  const findMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = before.match(/(?:^|[\s(])@([a-z0-9_-]*)$/i);
    setMention(
      match
        ? {
            start: caret - match[1]!.length - 1,
            end: caret,
            query: match[1]!,
          }
        : null,
    );
    setSelection(0);
  };

  const insertMention = (agent: ChannelAgent) => {
    if (!mention) return;
    const text = `@${agent.handle} `;
    setDraft((current) => ({
      ...current,
      text:
        current.text.slice(0, mention.start) +
        text +
        current.text.slice(mention.end),
    }));
    const caret = mention.start + text.length;
    setMention(null);
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(caret, caret);
    });
  };

  const editorBlocked = paused || uploading || voice !== "idle";
  const blocked = editorBlocked || pending;

  useEffect(() => {
    alive.current = true;
    void rpc.call("composer", null).then(
      (composer) => setVoiceEnabled(composer.voiceEnabled),
      () => {},
    );
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
      if (recording.current?.state === "recording") recording.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, [rpc]);

  useEffect(() => {
    if (!reply) return;
    setDraft((current) => ({ ...current, reply }));
    onClearReply();
    editor.current?.focus();
  }, [reply]);

  useEffect(() => {
    const element = editor.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(220, Math.max(68, element.scrollHeight))}px`;
  }, [draft.text]);

  const attach = async (files: File[]) => {
    if (blocked || !files.length) return;
    setError(null);
    if (draft.attachments.length + files.length > 10) {
      setError("Attach up to 10 files per message.");
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 8 * 1024 * 1024) {
          throw new Error(`${file.name} exceeds 8 MB.`);
        }
        const attachment = await rpc.call("upload", {
          id: roomId,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          data: await encode(file),
        });
        if (alive.current) {
          setDraft((current) => ({
            ...current,
            attachments: [
              ...current.attachments.filter(
                (candidate) => candidate.id !== attachment.id,
              ),
              attachment,
            ],
          }));
        }
      }
    } catch (cause) {
      if (alive.current) setError(errorText(cause));
    } finally {
      if (alive.current) setUploading(false);
    }
  };

  const send = async () => {
    if (
      sending.current ||
      blocked ||
      (!draft.text.trim() && !draft.attachments.length)
    ) {
      return;
    }
    if (modeFeedback?.kind === "error") return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      const prepared = prepareSend(
        localStorage,
        key,
        roomId,
        latestDraft.current,
      );
      setDraft(prepared.draft);
      await rpc.call("send", prepared.payload);
      const cleared = clearSentDraft(localStorage, key, prepared.draft);
      if (alive.current) {
        if (cleared) setDraft(emptyDraft());
        onClearReply();
        onSent();
        editor.current?.focus();
      }
    } catch (cause) {
      if (alive.current) setError(errorText(cause));
    } finally {
      sending.current = false;
      if (alive.current) setPending(false);
    }
  };

  const dictate = async () => {
    if (voice === "recording") {
      recording.current?.stop();
      return;
    }
    if (blocked || !voiceEnabled) return;
    setError(null);
    setVoice("starting");
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        throw new Error(
          "Dictation needs microphone access in a supported browser.",
        );
      }
      const deviceId = localStorage.getItem(
        "bb.voiceInput.audioInputDeviceId",
      );
      const media = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
      });
      if (!alive.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/webm",
      ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(
        media,
        mimeType ? { mimeType } : undefined,
      );
      recording.current = recorder;
      const chunks: Blob[] = [];
      let failed = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        failed = true;
        window.clearTimeout(timer.current);
        media.getTracks().forEach((track) => track.stop());
        if (alive.current) {
          setVoice("idle");
          setError("Microphone recording failed. Try again.");
        }
      };
      recorder.onstop = async () => {
        window.clearTimeout(timer.current);
        if (!failed) media.getTracks().forEach((track) => track.stop());
        recording.current = null;
        stream.current = null;
        if (!alive.current || failed) return;
        setVoice("transcribing");
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          if (blob.size > 5 * 1024 * 1024) {
            throw new Error("Recording exceeds 5 MB. Try a shorter message.");
          }
          const result = await rpc.call("transcribe", {
            data: await encode(blob),
            mimeType: blob.type,
            prompt: latestDraft.current.text,
          });
          if (alive.current) {
            setDraft((current) => ({
              ...current,
              text: `${current.text}${current.text ? " " : ""}${result.text}`,
            }));
            editor.current?.focus();
          }
        } catch (cause) {
          if (alive.current) setError(errorText(cause));
        } finally {
          if (alive.current) setVoice("idle");
        }
      };
      recorder.start();
      setVoice("recording");
      timer.current = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 120_000);
    } catch (cause) {
      stream.current?.getTracks().forEach((track) => track.stop());
      setError(errorText(cause));
      setVoice("idle");
    }
  };

  return (
    <div className="relative z-20 shrink-0">
      {mention && !editorBlocked ? (
        <div className="absolute bottom-[calc(100%-3px)] left-2 z-20 w-[min(26rem,calc(100%-1rem))]">
          <AgentOptions
            agents={agents}
            memberIds={memberIds}
            query={mention.query}
            selected={Math.min(selection, Math.max(0, optionCount - 1))}
            listId={listId}
            onHover={setSelection}
            onSelect={insertMention}
            onCreate={onCreateAgent}
          />
        </div>
      ) : null}
      <div
        className="group/promptbox relative w-full overflow-hidden rounded-xl border border-border bg-background shadow-lift"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            void attach(Array.from(event.dataTransfer.files));
          }
        }}
      >
        {draft.reply ? (
          <div className="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface-raised-solid px-3 py-1.5 text-xs">
            <Icon name="CornerDownRight" className="size-3.5" />
            <span className="min-w-0 flex-1">
              <strong className="block">Replying to {draft.reply.speaker}</strong>
              <span className="block truncate">
                {draft.reply.text.slice(0, 150) || "Attachment"}
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Cancel reply"
              onClick={() =>
                setDraft((current) => ({ ...current, reply: null }))
              }
            >
              <Icon name="X" />
            </Button>
          </div>
        ) : null}
        {draft.attachments.length ? (
          <div className="px-2 pt-1">
            <ChannelAttachments
              attachments={draft.attachments}
              disabled={pending}
              onRemove={async (attachment) => {
                if (sending.current || blocked) return;
                setUploading(true);
                try {
                  await rpc.call("discardAttachment", {
                    id: roomId,
                    attachmentId: attachment.id,
                  });
                  if (alive.current) {
                    setDraft((current) => ({
                      ...current,
                      attachments: current.attachments.filter(
                        (candidate) => candidate.id !== attachment.id,
                      ),
                    }));
                  }
                } catch (cause) {
                  if (alive.current) setError(errorText(cause));
                } finally {
                  if (alive.current) setUploading(false);
                }
              }}
            />
          </div>
        ) : null}
        <textarea
          ref={editor}
          autoFocus={autoFocus}
          aria-label="Message channel"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={!!mention && !editorBlocked}
          aria-controls={mention ? listId : undefined}
          aria-activedescendant={
            mention && optionCount
              ? `${listId}-${Math.min(selection, optionCount - 1)}`
              : undefined
          }
          className="block min-h-[4.25rem] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-65"
          placeholder={paused ? "Channel archived" : `Message #${roomName}…`}
          value={draft.text}
          maxLength={16_000}
          disabled={editorBlocked}
          rows={1}
          onChange={(event) => {
            setDraft((current) => ({ ...current, text: event.target.value }));
            findMention(event.target.value, event.target.selectionStart);
          }}
          onClick={(event) =>
            findMention(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            )
          }
          onBlur={(event) => {
            if (!event.relatedTarget?.closest("[role=listbox]")) {
              setMention(null);
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (!files.length) return;
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            if (text && !blocked && !sending.current) {
              const { selectionStart, selectionEnd } = event.currentTarget;
              setDraft((current) => ({
                ...current,
                text: (
                  current.text.slice(0, selectionStart) +
                  text +
                  current.text.slice(selectionEnd)
                ).slice(0, 16_000),
              }));
            }
            void attach(files);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (mention && !editorBlocked) {
              if (event.key === "Escape") {
                event.preventDefault();
                setMention(null);
                return;
              }
              if (
                optionCount &&
                (event.key === "ArrowDown" || event.key === "ArrowUp")
              ) {
                event.preventDefault();
                setSelection(
                  (current) =>
                    (current +
                      (event.key === "ArrowDown" ? 1 : optionCount - 1)) %
                    optionCount,
                );
                return;
              }
              if (
                optionCount &&
                ((event.key === "Enter" && !event.shiftKey) ||
                  event.key === "Tab")
              ) {
                event.preventDefault();
                const item = options[Math.min(selection, options.length)];
                if (item) insertMention(item);
                else onCreateAgent?.();
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="relative flex shrink-0 select-none items-center gap-3 pb-2 pl-3.5 pr-2 pt-1.5">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose attachments"
            onChange={(event) => {
              void attach(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Attach files"
            disabled={blocked}
            onClick={() => picker.current?.click()}
          >
            <Icon name="Plus" className="size-4" />
          </Button>
          <span className="min-w-0 flex-1 text-xs text-muted-foreground" role="status">
            {pending
              ? "Sending…"
              : uploading
                ? "Uploading…"
                : voice === "recording"
                  ? "Listening…"
                  : voice === "transcribing"
                    ? "Transcribing…"
                    : voice === "starting"
                      ? "Opening microphone…"
                      : ""}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className={`size-8 ${voice === "recording" ? "text-destructive" : ""}`}
            aria-label={
              voice === "recording"
                ? "Finish dictation"
                : voiceEnabled
                  ? "Dictate message"
                  : "Dictate message (enable voice transcription in BB settings)"
            }
            disabled={
              !voiceEnabled ||
              paused ||
              pending ||
              uploading ||
              voice === "starting" ||
              voice === "transcribing"
            }
            onClick={() => void dictate()}
          >
            <Icon name={voice === "recording" ? "Square" : "Mic"} className="size-4" />
          </Button>
          <Button
            size="sm"
            className="ml-1 px-3"
            aria-label="Send message"
            disabled={
              blocked ||
              modeFeedback?.kind === "error" ||
              (!draft.text.trim() && !draft.attachments.length)
            }
            onClick={() => void send()}
          >
            <Icon name="CornerDownLeft" className="size-4" />
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-1 px-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {modeFeedback ? (
        <p
          role={modeFeedback.kind === "error" ? "alert" : "status"}
          className={`mt-1 px-3 text-xs ${
            modeFeedback.kind === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          }`}
        >
          {modeFeedback.text}
        </p>
      ) : null}
      {footer ? <div className="mt-1 px-3">{footer}</div> : null}
    </div>
  );
}
