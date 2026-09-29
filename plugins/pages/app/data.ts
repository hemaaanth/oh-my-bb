import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PageDetail, PagesRpc } from "../contract.js";
import { messageOf } from "./ui.js";

// The app imports contract.ts for types only: a value import would bundle zod (~200 KB) into every
// BB window. app.test.tsx checks that these copies match the contract.
export const REALTIME_CHANNEL = "pages-changed";
export const pageDirective = (pageId: string, versionId: string) => `::page{id="${pageId}" version="${versionId}"}`;
export type Load<T> = { status: "idle" } | { status: "loading" } | { status: "missing" } | { status: "error"; message: string } | { status: "ready"; value: T };

/** `pages-changed` carries `{ pageId, versionId?, sourceKey? }`. */
export function changedPageId(payload: unknown): string | null {
  return payload && typeof payload === "object" && "pageId" in payload && typeof payload.pageId === "string" ? payload.pageId : null;
}
function changedSourceKey(payload: unknown): string | null {
  return payload && typeof payload === "object" && "sourceKey" in payload && typeof payload.sourceKey === "string" ? payload.sourceKey : null;
}

export const pageTag = (pageId: string) => `page:${pageId}`;
export const sourceTag = (sourceKey: string) => `source:${sourceKey}`;

// ---- One query cache per window ------------------------------------------------------------
// Every ::page card in a thread, the panel, and the Share popover read the same few RPCs. The cache
// keeps one entry per call, so any number of cards for a page cost one request, a remounted card
// (chat scrolling) costs none, and a `pages-changed` signal refetches each affected entry once.
// There are no timers: entries refresh on realtime signals, on reconnect, and on demand.

type Entry = {
  state: Load<unknown>;
  /** Invalidation tags, from the key and the last loaded value. */
  tags: readonly string[];
  load: () => Promise<Load<unknown>>;
  tagsOf: (state: Load<unknown>) => readonly string[];
  listeners: Set<() => void>;
  inflight: boolean;
  /** A signal arrived during a fetch, so fetch again when it lands. */
  again: boolean;
  /** Fetch on the next subscribe: the value may be out of date. */
  stale: boolean;
};

const IDLE: Load<never> = { status: "idle" };
const LOADING: Load<never> = { status: "loading" };
const MAX_IDLE_ENTRIES = 200;
const entries = new Map<string, Entry>();
/** Mounted cache hooks. While none are mounted, nobody hears realtime signals. */
let mounted = 0;

function setState(entry: Entry, state: Load<unknown>) {
  entry.state = state;
  if (state.status !== "error") entry.tags = entry.tagsOf(state);
  for (const listener of [...entry.listeners]) listener();
}

async function fetchEntry(entry: Entry) {
  if (entry.inflight) { entry.again = true; return; }
  entry.inflight = true;
  entry.stale = false;
  try {
    do {
      entry.again = false;
      setState(entry, await entry.load());
    } while (entry.again && entry.listeners.size > 0);
    if (entry.again) entry.stale = true;
  } finally {
    entry.inflight = false;
  }
}

function pruneIdle() {
  let idle = 0;
  for (const entry of entries.values()) if (entry.listeners.size === 0) idle += 1;
  // Map order is least recently subscribed first.
  for (const [key, entry] of entries) {
    if (idle <= MAX_IDLE_ENTRIES) break;
    if (entry.listeners.size === 0 && !entry.inflight) { entries.delete(key); idle -= 1; }
  }
}

const pendingTags = new Set<string>();
let flushQueued = false;
/** Refetch mounted entries with any of these tags ("*" matches all) and mark unmounted ones stale. Coalesced per task. */
export function invalidatePages(tags: readonly string[]) {
  for (const tag of tags) pendingTags.add(tag);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const hit = new Set(pendingTags);
    pendingTags.clear();
    for (const entry of entries.values()) {
      if (!hit.has("*") && !entry.tags.some((tag) => hit.has(tag))) continue;
      if (entry.listeners.size > 0) void fetchEntry(entry);
      else entry.stale = true;
    }
  });
}

/** Every mounted hook hears each signal; handle each payload once. */
const handled = new WeakSet<object>();
function onPagesChanged(payload: unknown) {
  if (payload && typeof payload === "object") {
    if (handled.has(payload)) return;
    handled.add(payload);
  }
  const pageId = changedPageId(payload);
  const sourceKey = changedSourceKey(payload);
  invalidatePages([...(pageId ? [pageTag(pageId)] : []), ...(sourceKey ? [sourceTag(sourceKey)] : [])]);
}

/** Signals sent while the connection was down are lost, so refetch everything after a reconnect. */
function useReconnectRefresh() {
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") invalidatePages(["*"]);
    previous.current = connection;
  }, [connection]);
}

/** Refetch one entry now (after the caller changed it), if it exists. */
export function refreshCached(key: string) {
  const entry = entries.get(key);
  if (entry) void fetchEntry(entry);
}

/** Replace a loaded value locally, e.g. with a mutation's result. */
export function updateCached<T>(key: string, update: (value: T) => T) {
  const entry = entries.get(key);
  if (entry?.state.status === "ready") setState(entry, { status: "ready", value: update(entry.state.value as T) });
}

/** Test hook: forget everything. */
export function resetPagesCache() {
  entries.clear();
  pendingTags.clear();
}

/**
 * The cached result of one RPC call. `key` names the call (null keeps the hook idle); `load` runs
 * it and never throws; `tagsOf` says which `pages-changed` signals make the result out of date.
 */
export function useCachedQuery<T>(key: string | null, load: () => Promise<Load<T>>, tagsOf: (state: Load<T>) => readonly string[]): Load<T> {
  const latest = useRef({ load, tagsOf });
  latest.current = { load, tagsOf };
  const subscribe = useCallback((listener: () => void) => {
    if (key === null) return () => undefined;
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key); // Re-insert: most recently used last.
    } else {
      entry = { state: LOADING, tags: [], load: () => Promise.resolve(LOADING), tagsOf: () => [], listeners: new Set(), inflight: false, again: false, stale: true };
    }
    entries.set(key, entry);
    // The newest subscriber's closures win; they all make the same call.
    entry.load = () => latest.current.load();
    entry.tagsOf = (state) => latest.current.tagsOf(state as Load<T>);
    if (entry.state.status === "loading") entry.tags = entry.tagsOf(entry.state);
    entry.listeners.add(listener);
    mounted += 1;
    if (entry.stale && !entry.inflight) void fetchEntry(entry);
    const subscribed = entry;
    return () => {
      subscribed.listeners.delete(listener);
      mounted -= 1;
      // Without a mounted hook no signal is heard, so nothing cached can be trusted after this.
      if (mounted === 0) for (const cached of entries.values()) cached.stale = true;
      pruneIdle();
    };
  }, [key]);
  const snapshot = useCallback(() => key === null ? IDLE : (entries.get(key)?.state ?? LOADING) as Load<T>, [key]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useRealtime(REALTIME_CHANNEL, onPagesChanged);
  useReconnectRefresh();
  return state;
}

export const pageKey = (pageId: string, versionId: string | null) => `getPage|${pageId}|${versionId ?? ""}`;

/**
 * One page, optionally at a pinned version. Shared by every card and panel in the window and
 * refreshed quietly when the server reports a change to this page. A null pageId keeps the hook idle.
 */
export function usePageDetail(pageId: string | null, versionId: string | null) {
  const rpc = useRpc<PagesRpc>();
  const key = pageId ? pageKey(pageId, versionId) : null;
  const state = useCachedQuery<PageDetail>(key, async () => {
    if (!pageId) return IDLE;
    try {
      const detail = await rpc.call("getPage", versionId ? { pageId, versionId } : { pageId });
      return detail ? { status: "ready", value: detail } : { status: "missing" };
    } catch (error) {
      return { status: "error", message: messageOf(error, "The page could not load.") };
    }
  }, () => pageId ? [pageTag(pageId)] : []);
  const reload = useCallback(() => { if (key) refreshCached(key); }, [key]);
  return { state, reload };
}
