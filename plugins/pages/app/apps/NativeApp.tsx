import { useCallback, useRef, useState } from "react";
import { experimental_saveFile, useComposers, useSdk } from "@get-bb/plugin-sdk/app";
import { useHost } from "../spec/host.js";
import { focusRing } from "../ui.js";
import { AppBlock, type AppBlockProps } from "./AppBlock.js";
import { GALLERY_SHEET, sheetFor, useAnswerComposers, useBlockAnswers } from "./answerSheet.js";

/** Only the app's own thread is attached. Existing Pages forms keep their direct-send path. */
export function NativeApp(props: AppBlockProps) {
  const host = useHost();
  const sdk = useSdk();
  const composers = useComposers();
  const own = composers.filter((composer) => composer.scope.kind === "thread" && composer.scope.threadId === host.threadId);
  useAnswerComposers(own);
  const sheet = host.threadId ? sheetFor(host.threadId) : GALLERY_SHEET;
  const answers = useBlockAnswers(sheet, props.stateKey);
  const staged = answers.staged.get("app");
  const sent = answers.sent?.at(-1)?.text;
  const lock = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stage = useCallback((text: string | null) => {
    setError(null);
    if (text === null) { sheet.withdraw(props.stateKey, "app"); return; }
    sheet.stage({ block: props.stateKey, question: "app", selection: true, text, message: host.blockKey ?? props.stateKey, reply: null, fence: 0, position: 0 });
  }, [sheet, props.stateKey, host.blockKey]);
  const send = async () => {
    if (!host.threadId || !staged || lock.current) return;
    lock.current = true;
    setSending(true);
    setError(null);
    try {
      await sdk.threads.send({ threadId: host.threadId, mode: "queue-if-active", input: [{ type: "text", text: staged.text, mentions: [] }] });
      sheet.markSent(props.stateKey, "app", staged.text);
      if (sheet.snapshot(props.stateKey).staged.get("app")?.text === staged.text) sheet.withdraw(props.stateKey, "app");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not send the app answer."); }
    finally { lock.current = false; setSending(false); }
  };
  const feedback = error ? <p role="alert" className="my-2 text-xs text-destructive">{error}</p> : staged ? <div role="status" className="mt-2 flex min-w-0 flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
    {host.threadId ? answers.composer ? <button type="button" className={`cursor-pointer underline underline-offset-2 ${focusRing}`} onClick={() => own[0]?.focus()}>In message</button>
      : <button type="button" disabled={sending} className={`cursor-pointer underline underline-offset-2 disabled:opacity-50 ${focusRing}`} onClick={() => void send()}>{sending ? "Sending…" : "Send answer"}</button> : <span>Preview answer</span>}
    <span className="min-w-0 whitespace-pre-wrap break-words">{staged.text}</span>
    <button type="button" className={`cursor-pointer underline underline-offset-2 ${focusRing}`} onClick={() => sheet.withdraw(props.stateKey, "app")}>Remove</button>
  </div> : sent ? <details className="mt-2 text-xs text-muted-foreground"><summary className={`w-fit cursor-pointer ${focusRing}`}>Sent</summary><p className="mb-0 whitespace-pre-wrap break-words">{sent}</p></details> : undefined;
  return <AppBlock {...props} persist={host.kind === "chat"} onAnswer={stage} feedback={feedback} onDownload={async (fileName, blob) => {
    if (await experimental_saveFile({ fileName, blob }) === "failed") throw new Error("Could not start the download.");
  }} />;
}
