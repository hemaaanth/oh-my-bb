import { useCallback, useMemo, useRef, useState } from "react";
import { BuiltinActionType, type ActionEvent, type ParseResult } from "@openuidev/react-lang";
import { useSdk, type ExperimentalCodeFenceRendererProps } from "@get-bb/plugin-sdk/app";
import { specLibrary } from "./spec/catalog.js";
import { HostContext } from "./spec/host.js";
import { SentContext } from "./spec/kit.js";
import { useBbHost, useBbTools } from "./specHost.js";
import { QuietLine, messageOf } from "./ui.js";
import { annotateSources } from "./spec/source-metadata.js";
import { MotionBoundary } from "./spec/motion.js";
import { SpecRenderer } from "./spec/SpecRenderer.js";
import { recordReply, type ReplyThreads } from "./reply.js";
import { formFields, replyParts, type FormFields } from "./spec/answers.js";

export { SPEC_LANGUAGES } from "../render/spec-baked.js";

function readState(key: string): Record<string, unknown> | undefined {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function writeState(key: string, value: Record<string, unknown>): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: state stays in memory */ }
}

/**
 * One ```openui-lang fence in an assistant reply, rendered with the spec library as it streams.
 * BB keeps this component mounted for the whole stream. A fence that never parses shows BB's code block.
 */
export function SpecFence({ code, language, status, index, message, Original }: ExperimentalCodeFenceRendererProps) {
  const sdk = useSdk();
  const fenceKey = `${message.id}#${language}#${index}`;
  const stateKey = `bb.pages.spec:${fenceKey}`;
  const host = useBbHost("chat", { threadId: message.threadId, blockKey: stateKey, appsReady: status === "closed" });
  const tools = useBbTools(message.threadId);
  const sentKey = `${stateKey}:sent`;
  const [initialState] = useState(() => readState(stateKey));
  // A sent Form stays locked after a reload, like forms on pages.
  const [sent, setSent] = useState(() => (readState(sentKey) ?? {}) as Record<string, string>);
  const [hasRoot, setHasRoot] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Field labels for the sent text. Read at send time, so a ref is enough.
  const fields = useRef<FormFields>(new Map());
  const card = useRef<HTMLDivElement>(null);

  const onParseResult = useCallback((result: ParseResult | null) => {
    annotateSources(result);
    setHasRoot(Boolean(result?.root));
    fields.current = formFields(result);
  }, []);
  const onStateUpdate = useCallback((state: Record<string, unknown>) => writeState(stateKey, state), [stateKey]);
  const mark = useCallback((form: string, label: string | null) => setSent((current) => {
    const next = { ...current };
    if (label === null) delete next[form]; else next[form] = label;
    writeState(sentKey, next);
    return next;
  }), [sentKey]);
  const sentValue = useMemo(() => ({ sent, unlock: (form: string) => mark(form, null) }), [sent, mark]);
  const onAction = useCallback((event: ActionEvent) => {
    if (event.type === BuiltinActionType.OpenUrl) {
      host.openUrl(String(event.params.url ?? ""));
      return;
    }
    if (event.type !== BuiltinActionType.ContinueConversation) return;
    const heading = card.current?.querySelector("h1, h2, h3, h4")?.textContent ?? undefined;
    const { text, context, quote } = replyParts(event, fields.current, heading);
    if (!text) return;
    const form = event.formName ?? "";
    // Lock before sending, so a double click sends once. A failed send unlocks.
    mark(form, event.humanFriendlyMessage || text);
    // The bubble shows only the answer; the agent also gets the question in a part only it sees.
    const input = [{ type: "text" as const, text, mentions: [] }, ...(context ? [{ type: "text" as const, text: context, visibility: "agent-only" as const, mentions: [] }] : [])];
    setError(null);
    // Record the reply first, so the header over the sent message finds it. A failed record still sends.
    recordReply(sdk.threads as unknown as ReplyThreads, message.threadId, text, fenceKey, quote)
      .catch(() => undefined)
      .then(() => sdk.threads.send({ threadId: message.threadId, mode: "queue-if-active", input }))
      .catch((cause: unknown) => {
        mark(form, null);
        setError(messageOf(cause, "Could not send to the thread."));
      });
  }, [sdk, host, message.threadId, fenceKey, mark]);

  // A fence that ends without a root shows BB's code block. The Renderer stays mounted, so its state survives.
  const failed = !code.trim() || (status !== "streaming" && hasRoot === false);
  return <>
    {failed ? <Original /> : null}
    <div ref={card} hidden={failed} data-pages-fence={fenceKey} className="my-2 min-w-0">
      <HostContext.Provider value={host}>
        <MotionBoundary>
        <SentContext.Provider value={sentValue}>
          <SpecRenderer response={code} library={specLibrary} isStreaming={status === "streaming"} initialState={initialState} onStateUpdate={onStateUpdate} onParseResult={onParseResult} onAction={onAction} toolProvider={tools} />
        </SentContext.Provider>
        </MotionBoundary>
      </HostContext.Provider>
      {error ? <QuietLine tone="error">{error}</QuietLine> : null}
    </div>
  </>;
}
