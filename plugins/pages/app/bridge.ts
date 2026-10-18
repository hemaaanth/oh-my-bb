// The host side of the frame bridge. Protocol: FRAME_MESSAGE in contract.ts. Page side: render/frame-bridge.ts.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { FRAME_MESSAGE, HOST_TOKENS, HOST_TOKEN_VALUE, formSubmissionSchema, type FormSubmission, type FormTarget, type PagesRpc, type SentForm } from "../contract.js";
import { messageOf, themedUrl, usePreviewTheme } from "./ui.js";

/** Far taller than any page a chat frame shows. A larger report is noise. */
const MAX_REPORTED_HEIGHT = 100_000;
const MAX_URL_LENGTH = 8_192;

export type FrameMessage =
  | { type: "ready" }
  | { type: "open" | "page"; url: string }
  | { type: "height"; height: number }
  | { type: "submit"; submission: FormSubmission }
  | { type: "submit-invalid"; submissionId: string; message: string };

export type { FormTarget };
const NO_FORM_TARGET = "This view cannot send forms. Open the page in a thread.";

/** A page's message, checked. Anything else, including a link that is not http(s), is null. */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, url, height } = data as Record<string, unknown>;
  if (type === FRAME_MESSAGE.submit) {
    const { type: _type, ...fields } = data as Record<string, unknown>;
    const parsed = formSubmissionSchema.safeParse(fields);
    if (parsed.success) return { type: "submit", submission: parsed.data };
    // A form too large or malformed still gets an answer, so its status line does not wait.
    const { submissionId } = fields;
    return typeof submissionId === "string" && /^[A-Za-z0-9_-]{8,64}$/u.test(submissionId)
      ? { type: "submit-invalid", submissionId, message: parsed.error.issues.find((issue) => issue.code === "custom")?.message ?? "The form could not be read." }
      : null;
  }
  if (type === FRAME_MESSAGE.ready) return { type: "ready" };
  if (type === FRAME_MESSAGE.open) {
    if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? { type: "open", url: parsed.href } : null;
    } catch {
      return null;
    }
  }
  if (type === FRAME_MESSAGE.page) {
    return typeof url === "string" && url.length <= MAX_URL_LENGTH ? { type: "page", url } : null;
  }
  if (type === FRAME_MESSAGE.height) {
    return typeof height === "number" && Number.isFinite(height) && height > 0 && height <= MAX_REPORTED_HEIGHT ? { type: "height", height: Math.ceil(height) } : null;
  }
  return null;
}

/**
 * A folder page link, checked against the frame's current src. Only the sibling `v` or `a` route,
 * on the same origin and for the same version, passes: a page cannot load another page into its frame.
 * Returns the URL without theme or frame, as a path when it is on the app's origin, or null.
 */
export function folderPageUrl(url: string, frameSrc: string): string | null {
  try {
    const current = new URL(frameSrc, window.location.href);
    const target = new URL(url, current);
    const routes = current.pathname.replace(/[^/]*$/u, "");
    if (target.origin !== current.origin || (target.pathname !== `${routes}v` && target.pathname !== `${routes}a`)) return null;
    if (!current.searchParams.get("id") || target.searchParams.get("id") !== current.searchParams.get("id")) return null;
    target.searchParams.delete("theme");
    target.searchParams.delete("frame");
    return target.origin === window.location.origin ? `${target.pathname}${target.search}${target.hash}` : target.href;
  } catch {
    return null;
  }
}

/** The app's current HOST_TOKENS values, read from its root. An empty or unsafe value is left out. */
export function hostTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of HOST_TOKENS) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (HOST_TOKEN_VALUE.test(value)) tokens[name] = value;
  }
  return tokens;
}

export const themeMessage = (theme: "light" | "dark") => ({ type: FRAME_MESSAGE.theme, theme, tokens: hostTokens() });

/**
 * One preview iframe's side of the bridge. The first theme rides in the URL, so the page paints themed.
 * The theme and the app's tokens are posted when the page asks (ready), on load, and when the app theme changes,
 * so the src stays the same and the page does not reload.
 * Only messages from this iframe's own window count. The frame stays sandboxed without allow-same-origin.
 * A submitted form goes to `forms` with submitForm; without a target, the form is told why it cannot send.
 * Forms already sent to `forms` are posted on each load, so the page shows them sent.
 */
export function useFrameBridge(previewUrl: string, frame?: "card" | "inline", onHeight?: (height: number) => void, forms?: FormTarget | null) {
  const navigate = useBbNavigate();
  const rpc = useRpc<PagesRpc>();
  const theme = usePreviewTheme();
  const ref = useRef<HTMLIFrameElement>(null);
  // A new page or version loads with the theme of that moment.
  const [loaded, setLoaded] = useState({ previewUrl, theme });
  if (loaded.previewUrl !== previewUrl) setLoaded({ previewUrl, theme });
  // A folder page the reader opened from a link. A new page or version drops it.
  const [page, setPage] = useState<{ previewUrl: string; src: string } | null>(null);
  const postTheme = useCallback(() => { ref.current?.contentWindow?.postMessage(themeMessage(theme), "*"); }, [theme]);
  useEffect(() => {
    postTheme();
    // The app sets its theme class and custom palette on its root. Read the tokens again when they change.
    const observer = new MutationObserver(postTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [postTheme]);
  // One key per target, so a new object with the same fields does not refetch or rebind.
  const formsKey = forms ? JSON.stringify(forms) : "";
  const target = useRef(forms);
  target.current = forms;
  const sent = useRef<SentForm[]>([]);
  const postSent = useCallback(() => {
    if (sent.current.length) ref.current?.contentWindow?.postMessage({ type: FRAME_MESSAGE.restore, forms: sent.current }, "*");
  }, []);
  const loadSent = useCallback(() => {
    const forms = target.current;
    if (!forms) return;
    rpc.call("sentForms", forms).then(
      (result) => {
        // A late answer for an old target is dropped.
        if (JSON.stringify(target.current) !== JSON.stringify(forms)) return;
        sent.current = result.forms;
        postSent();
      },
      () => {},
    );
  }, [rpc, postSent]);
  useEffect(() => { sent.current = []; loadSent(); }, [formsKey, loadSent]);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const own = ref.current?.contentWindow;
      if (!own || event.source !== own) return;
      const message = readFrameMessage(event.data);
      if (message?.type === "ready") {
        postTheme();
      } else if (message?.type === "page") {
        const url = folderPageUrl(message.url, ref.current?.getAttribute("src") ?? "");
        // The theme goes before the fragment, so a link to a section keeps it.
        const cut = url?.indexOf("#") ?? -1;
        if (url) setPage({ previewUrl, src: cut < 0 ? themedUrl(url, theme, frame) : themedUrl(url.slice(0, cut), theme, frame) + url.slice(cut) });
      } else if (message?.type === "open") {
        if (!navigate.openUrl(message.url)) window.open(message.url, "_blank", "noopener,noreferrer");
      } else if (message?.type === "height") {
        onHeight?.(message.height);
      } else if (message?.type === "submit" || message?.type === "submit-invalid") {
        const reply = (submissionId: string, ok: boolean, text = "") => own.postMessage({ type: FRAME_MESSAGE.submitted, submissionId, ok, message: text }, "*");
        if (message.type === "submit-invalid") reply(message.submissionId, false, message.message);
        else if (!forms) reply(message.submission.submissionId, false, NO_FORM_TARGET);
        else {
          const { submissionId } = message.submission;
          rpc.call("submitForm", { ...forms, ...message.submission }).then(
            (result) => {
              reply(submissionId, result.ok, result.ok ? "" : result.message);
              // The frame shows the form sent. Reload the list, so a later load of the frame does too.
              if (result.ok) loadSent();
            },
            (error: unknown) => reply(submissionId, false, messageOf(error, "The form could not be sent.")),
          );
        }
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  // formsKey stands for forms.
  }, [navigate, onHeight, previewUrl, theme, frame, rpc, formsKey, loadSent, postTheme]);
  // The frame's colour scheme matches the app's. A mismatch makes the browser paint an opaque backdrop behind the page.
  const style: CSSProperties = { colorScheme: theme };
  const src = page?.previewUrl === previewUrl ? page.src : themedUrl(loaded.previewUrl, loaded.theme, frame);
  const onLoad = useCallback(() => { postTheme(); postSent(); }, [postTheme, postSent]);
  return { ref, src, onLoad, style };
}
