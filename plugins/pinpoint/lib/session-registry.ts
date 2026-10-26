import { PREVIEW_SANDBOX } from "./protocol";

// Keeps proxied browser iframes alive across panel mount/unmount. A
// `PinpointPanel` fully unmounts whenever the user switches threads or closes
// the tab (the host renders only the active panel, nothing is kept mounted
// hidden) — so without this, every navigation away re-fetches and
// re-initializes the proxied page from scratch. Sessions live at module
// scope, outside React, and their iframes are parked in a detached "holding
// pen" appended directly to `document.body` when no panel currently wants
// them, so an unmount never touches their DOM node.
export interface PinpointSession {
  key: string;
  threadId: string;
  url: string;
  iframe: HTMLIFrameElement;
  pinned: boolean;
  attached: boolean;
  lastUsed: number;
  connected: boolean;
  frameReady: boolean;
  currentUrl: string;
  blocked: string | null;
  /** One automatic protocol-mismatch reload has already been tried. */
  protocolReloadAttempted: boolean;
  pickerAuthToken: string | null;
  acceptNextPickerToken: boolean;
}

const sessions = new Map<string, PinpointSession>();
const lastSessionByThread = new Map<string, string>();

// Cap on unpinned, currently-backgrounded sessions. Pinned sessions and the
// one a panel is actively showing are never evicted by this.
const MAX_UNPINNED_SESSIONS = 4;

let pen: HTMLDivElement | null = null;
function holdingPen(): HTMLDivElement {
  if (pen && pen.isConnected) return pen;
  pen = document.createElement("div");
  pen.setAttribute("data-pinpoint-holding-pen", "");
  pen.style.cssText =
    "position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;";
  document.body.appendChild(pen);
  return pen;
}

export function sessionKey(threadId: string, url: string): string {
  return `${threadId}::${url}`;
}

export function getSession(key: string): PinpointSession | undefined {
  return sessions.get(key);
}

/** The live session the thread most recently displayed, even after unmount. */
export function getLastSession(threadId: string): PinpointSession | undefined {
  const key = lastSessionByThread.get(threadId);
  return key ? sessions.get(key) : undefined;
}

export function createSession(
  threadId: string,
  url: string,
  src: string,
): PinpointSession {
  const key = sessionKey(threadId, url);
  const existing = sessions.get(key);
  if (existing) return existing;
  const iframe = document.createElement("iframe");
  iframe.title = "Pinpoint browser";
  iframe.src = src;
  iframe.setAttribute("sandbox", PREVIEW_SANDBOX);
  iframe.referrerPolicy = "no-referrer";
  iframe.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;";
  holdingPen().appendChild(iframe);
  const session: PinpointSession = {
    key,
    threadId,
    url,
    iframe,
    pinned: false,
    attached: false,
    lastUsed: Date.now(),
    connected: false,
    frameReady: false,
    currentUrl: url,
    blocked: null,
    protocolReloadAttempted: false,
    pickerAuthToken: null,
    acceptNextPickerToken: true,
  };
  sessions.set(key, session);
  evict(key);
  return session;
}

export function attach(session: PinpointSession, host: HTMLElement): void {
  if (session.iframe.parentElement !== host) host.appendChild(session.iframe);
  session.attached = true;
  session.lastUsed = Date.now();
  lastSessionByThread.set(session.threadId, session.key);
}

export function detach(session: PinpointSession): void {
  // Reload may remove a session before React runs the old effect cleanup.
  // Never let that stale cleanup resurrect the removed iframe in the pen.
  if (sessions.get(session.key) !== session) return;
  session.attached = false;
  session.lastUsed = Date.now();
  const p = holdingPen();
  if (session.iframe.parentElement !== p) p.appendChild(session.iframe);
  evict();
}

export function removeSession(key: string): void {
  const s = sessions.get(key);
  if (!s) return;
  s.iframe.remove();
  sessions.delete(key);
  if (lastSessionByThread.get(s.threadId) === key) {
    const fallback = [...sessions.values()]
      .filter((candidate) => candidate.threadId === s.threadId)
      .sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (fallback) lastSessionByThread.set(s.threadId, fallback.key);
    else lastSessionByThread.delete(s.threadId);
  }
}

export function setPinned(key: string, pinnedNext: boolean): void {
  const s = sessions.get(key);
  if (s) {
    s.pinned = pinnedNext;
    if (!pinnedNext) evict();
  }
}

export function reloadSession(
  session: PinpointSession,
  currentUrl: string,
  src: string,
): void {
  session.currentUrl = currentUrl;
  session.connected = false;
  session.frameReady = false;
  session.blocked = null;
  session.pickerAuthToken = null;
  session.acceptNextPickerToken = true;
  session.lastUsed = Date.now();
  session.iframe.src = src;
}

export function disposeAll(): void {
  for (const session of sessions.values()) session.iframe.remove();
  sessions.clear();
  lastSessionByThread.clear();
  pen?.remove();
  pen = null;
}

// Least-recently-used unpinned, backgrounded sessions get dropped once there
// are more than MAX_UNPINNED_SESSIONS of them, so leaving pages open forever
// doesn't grow memory/CPU without bound. `exceptKey` is the session that just
// got created (about to be attached), never itself a candidate.
function evict(exceptKey?: string): void {
  const evictable = [...sessions.values()]
    .filter((s) => !s.pinned && !s.attached && s.key !== exceptKey)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  const overBy = evictable.length - MAX_UNPINNED_SESSIONS;
  for (let i = 0; i < overBy; i++) removeSession(evictable[i].key);
}
