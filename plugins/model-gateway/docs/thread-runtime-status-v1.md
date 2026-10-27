# Cached thread runtime status — V1

Source-owned RPC: `model-gateway.threadRuntimeStatusV1({ threadId })`.
Input and output schemas: `src/thread-runtime-status.ts`, registered in
`src/rpc.ts`. This is an additive read. Existing methods and UI are unchanged.
No Machine consumer is installed by this contract.

## Access and bounds

Input is exactly `{ threadId: string }`, with 1–256 characters. Extra fields,
arrays, missing IDs, and host selectors are rejected. There is no enumeration.
The host-provided `experimental_caller` must be `{ kind: "client" }` or
`{ kind: "plugin", pluginId: "machine" }`. Absent context and every other plugin
are denied before storage access. An input caller label grants nothing.

SDK 0.6.49 defines plugin callers as loaded plugins authenticated by a per-load
server token through `bb.sdk.plugins.callRpc`. Other host-authenticated callers
(app, CLI, agents, and BB) are `client`. This handler trusts that host boundary;
it does not authenticate arbitrary caller-supplied JSON as a context.
This read grants no execution, consent, account, or routing authority.

## Exact DTO

```ts
type ThreadRuntimeStatusV1 = {
  schemaVersion: 1;
  threadId: string; // Exact input ID, never a substituted thread.
  readAt: number;
  configuredRouting: { status: "not-evaluated" };
} & (
  | { availability: "missing"; observedAt: null; stale: null; route: null }
  | { availability: "expired"; observedAt: number; stale: true; route: null }
  | {
      availability: "observed";
      observedAt: number;
      stale: boolean;
      route: {
        harness: "claude-code" | "codex" | "acp-omp" | "acp-fx"
          | "acp-nanocodex" | "acp-prime-agent" | "pi" | null;
        model: string | null;
        requestedModel: string | null;
        autoModel: string | null;
        fallback: "primary" | "fallback" | "unknown";
        fallbackCause: null | {
          category: "transport" | "authentication" | "rate-limit" | "availability";
          status: number;
          observedAt: number;
        };
      };
    }
);
```

All objects are strict. Timestamps are nonnegative safe-integer Unix
milliseconds. Fallback status is an integer from 0 through 599 (0 can describe
a transport failure). Model IDs have 1–256 characters and match
`^[A-Za-z0-9][A-Za-z0-9._/-]*$`. Unknown, empty, oversized, or unsupported model
IDs become null, not a guessed display name. Unsupported harnesses become null.

`observedAt` is the saved route's `usedAt`: when Gateway last recorded a served
route, not completion time, process liveness, or time of this read. `readAt` is
the local clock at projection time. `stale` is true at an age of at least
30 minutes, or when the observation is in the future (clock skew). More than
seven days old is `expired`; the observation time remains, but the route does
not. Exactly seven days is stale, not expired. Reads never delete expired rows.
A row already removed by normal lifecycle pruning is `missing`; its history
cannot be recovered by this read. Missing is not evidence that routing is off.

`model` is the last saved upstream model. `requestedModel` is the saved client
request model. `autoModel` is the saved Auto pick, not a new Auto evaluation.
`fallback` maps saved reason `primary` to primary and `fallback` or
`primary exhausted` to fallback. Other reasons are unknown. The cause describes
a recorded primary rejection and can predate the latest served route. Null
means no supported recorded cause, not proof no rejection happened.

Current routing is deliberately **not evaluated**. No current chain is returned
as historical fact. The store has no historical chain or chain index. A cached
route proves neither that a process is running nor what the next request will
use. Machine must not use this DTO as a routing or authorization decision.

## Source-read map and privacy

`server.ts` creates one existing `ThreadRouteStore(db)` shared by the hub and
`createThreadRuntimeStatusHandlers`. The registered handler checks the SDK
caller, then calls `routes.get(threadId)`. `upstreams/store.ts` performs one
parameterized `SELECT * FROM thread_route WHERE thread_id = ?` and parses the
local row. The handler constructs the bounded DTO field by field. There is no
route/cache write or retained handler cache.

No account reference is needed. Account labels, emails, upstream IDs, URLs,
credentials, headers, request content, raw chains, free-form reasons, and
upstream error messages are not output fields. Redaction uses explicit output
construction, not string replacement. Model fields contain identifiers only.
The read never resolves accounts, current settings, current chains, hosts,
SDK secrets, or account secret files. It never fetches, decrypts, refreshes,
prunes, rotates, starts services, emits events, or performs a machine operation.

Do not replace this path with `hub.threadStatus`: that method reads account
metadata and recomputes today's chain. Do not use `thread.route` or
`operations.list`: list calls status, which lists hosts and prunes hub tokens.
Normal plugin startup still has its existing initialization and token pruning;
this RPC adds no startup work and does not start the hub or discovery services.

## Validation and release

`src/thread-runtime-status.test.ts` drives the registered actual factory with
throwaway SQL/KV and fake SDK, seeded route observations, and no model traffic.
It covers observed/missing/stale/expired state, current-policy separation,
caller denial before storage, strict bounds, PII omission, and repeated reads.
Synthetic counters assert no account, host, secret, overview, token-prune,
route-write, KV, filesystem, or remote work during reads. Database bytes and
`total_changes()` stay unchanged. Production-bundle smoke uses the same actual
factory and registered handler with disposable stores.

Package version remains 0.3.1. This source change does not publish or move any
release ref. The lead owns the immutable compatible release/ref and registry
update after integration. No live Gateway or native UI verification is claimed.
