// bb-plugin-pinpoint — backend.
//
// Point at anything in a live browser inside bb and hand it to the agent as
// reviewable feedback. Fully bb-native and harness-agnostic:
//   * a same-origin proxy renders any URL and injects an element picker
//     (no app changes, no agentation, works on local/remote/sandbox URLs);
//   * picks are persisted server-side in the plugin database (never
//     client-only) and relayed into the thread (or a spawned review chat);
//   * any agent addresses them and marks them ready-to-review via a native
//     bb tool (pinpoint_resolve) OR the universal `bb pinpoint ready` CLI;
//   * the panel is the approve / re-feedback surface.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract.js";
import {
  PREVIEW_MAX_BYTES, PreviewSessions, assertPreviewUrl, collectResourceOrigins,
  previewHeaders, previewResourceUrl, readPreviewBody, rewritePreviewHtmlModules, rewritePreviewModules,
} from "./lib/preview-security";
import {
  guestCaptureInputSchema, guestCaptureReceiptSchema, guestReviewScopeSchema,
  guestRowInputSchema, guestRowSchema, preparedGuestResourceSchema, publicGuestAnnotationSchema,
  guestFeedbackSchema, type GuestFeedback,
  type GuestActor, type GuestReviewScope, type GuestRow,
} from "./lib/guest-review";
import { GuestScreenshotGrants } from "./lib/guest-screenshots";

import {
  AFS_VERSION,
  afsAnnotationSchema,
  annotationFromLegacy,
  appendThreadMessage,
  captureSchema,
  createAfsAnnotation,
  isAgentInboxState,
  reviewStateSchema,
  workflowStateFor,
  workflowStateSchema,
  type CaptureInput,
  type AfsAnnotation,
  type WorkflowState,
} from "./lib/afs";
import {
  abandonRouting,
  chooseDispatchTarget,
  claimRouting,
  completeRouting,
  failRouting,
  getRouting,
  ensureRoutingRows,
  recoverInterruptedDispatches,
  routingStateSchema,
  stageRouting,
  type AnnotationRouting,
} from "./lib/routing";
import { classifyDelivery, type DeliveryEvent } from "./lib/delivery-check";
import {
  checkProviderHealth,
  type UsageMachine,
} from "./lib/provider-health";
import {
  annotationFor,
  approveAnnotation as storeApprove,
  dismissAnnotation as storeDismiss,
  getAnnotationRow,
  getScreenshot,
  migrations,
  patchPinpoint,
  removeAnnotation as storeRemove,
  reopenAnnotation as storeReopen,
  routingFor as storeRoutingFor,
  screenshotKinds,
  sameCapturePage,
  SCREENSHOT_MAX_BASE64_CHARS,
  screenshotKindsFor,
  screenshotKindsForMany,
  screenshotsFor,
  storeScreenshot,
  writeAnnotation as storeWriteAnnotation,
  type AnnotationRow,
  type ScreenshotKind,
  type StoreResult,
} from "./lib/store";
import {
  applyResolveOutcome,
  parseLearningFlag,
  parseScopeFlag,
  readReceiptFile,
  resolveOutcomes,
} from "./lib/resolve";
import { learningTopics } from "./lib/clasi-rules";
import {
  performLearningWrite,
  recordLearningConsent,
  type LearningWriteDeps,
} from "./lib/learning-write";
import {
  scopeBreadths,
  scopeTargets,
  type ScopeBreadth,
  type ScopeTarget,
} from "./lib/afs";
import {
  TOOL_LIST,
  TOOL_RESOLVE,
  TOOL_SHOW,
  agentNagInstruction,
  cmdApprove,
  cmdAsk,
  cmdComment,
  cmdDelete,
  cmdList,
  cmdReady,
  cmdReject,
  cmdShow,
  cmdStatus,
  listToolInstruction,
  resolveToolDescription,
  reviewAgentSpawnPrompt,
  textEditAgentSpawnPrompt,
} from "./lib/commands";
import { GUEST_PREVIEW_ISOLATION_VERSION, PICKER_PROTOCOL_VERSION } from "./lib/protocol";
import {
  dispatchMessageFor,
  visibleDispatchMessageFor,
} from "./lib/dispatch-message";
import { buildShowResult } from "./lib/show-result";
import { PUBLIC_REVIEW_CLIENT_JS } from "./lib/public-review-client.generated";
import { LIVE_TARGET_TTL_MS } from "./lib/live-target";

// ---------------------------------------------------------------------------
// snapdom (in-page DOM screenshots), embedded at MODULE INIT so the served
// script survives `bb plugin build` bundling as long as node_modules ships
// with the installed plugin. Every path is guarded: when the IIFE can't be
// found (stripped node_modules, bundled layout we didn't predict) screenshots
// are simply disabled — annotations keep working, nothing crashes (R1/AE1).
// ---------------------------------------------------------------------------
function loadSnapdomSource(): string | null {
  const candidates: string[] = [];
  // The package's exports map only exposes the bare specifier (not
  // ./dist/snapdom.js), so resolve the entry and normalize to the browser
  // (IIFE) build — under the "require" condition that's snapdom.js already.
  try {
    candidates.push(
      createRequire(import.meta.url)
        .resolve("@zumer/snapdom")
        .replace(/snapdom\.mjs$/, "snapdom.js"),
    );
  } catch {
    /* resolver unavailable (bundled layout, stripped deps) — try file paths */
  }
  // Walk up from the module dir (dist/server.js after `bb plugin build`) to
  // find the plugin's own node_modules.
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 4; depth += 1) {
      candidates.push(
        join(dir, "node_modules/@zumer/snapdom/dist/snapdom.js"),
      );
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta.url not a file URL */
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    } catch {
      /* unreadable candidate — keep looking */
    }
  }
  return null;
}

export const PUBLIC_REVIEW_BASE_STYLES = `
[data-bb-plugin="pinpoint"] {
  --background: var(--canvas);
  --foreground: var(--ink);
  --card: var(--surface);
  --card-foreground: var(--ink);
  --popover: var(--surface);
  --popover-foreground: var(--ink);
  --primary: var(--ink);
  --primary-foreground: var(--canvas);
  --secondary: var(--raised);
  --secondary-foreground: var(--ink);
  --muted: var(--raised);
  --muted-foreground: var(--subtle);
  --accent: var(--raised);
  --accent-foreground: var(--ink);
  --destructive: var(--danger);
  --destructive-foreground: var(--canvas);
  --border: var(--line);
  --input: var(--line);
  --ring: var(--muted);
  --radius: 0.625rem;
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
[data-bb-plugin="pinpoint"],
[data-bb-plugin="pinpoint"] *,
[data-bb-plugin="pinpoint"] *::before,
[data-bb-plugin="pinpoint"] *::after { box-sizing: border-box; }
[data-bb-plugin="pinpoint"] button,
[data-bb-plugin="pinpoint"] input,
[data-bb-plugin="pinpoint"] textarea { font: inherit; }
[data-bb-plugin="pinpoint"] button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
}
[data-bb-plugin="pinpoint"] :is(h1, h2, h3, h4, p, ul, ol) { margin: 0; }
[data-bb-plugin="pinpoint"] :is(ul, ol) { list-style: none; padding: 0; }
[data-bb-plugin="pinpoint"] svg { display: block; }
`;

function loadPublicReviewStyles(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(moduleDir, "dist", "app.css"),
    join(moduleDir, "app.css"),
  ]) {
    try {
      return `${PUBLIC_REVIEW_BASE_STYLES}\n${readFileSync(candidate, "utf8")}`;
    } catch {
      continue;
    }
  }
  return PUBLIC_REVIEW_BASE_STYLES;
}
const SNAPDOM_SOURCE = loadSnapdomSource();

const routingSchema = z.object({
  annotationId: z.string(),
  state: routingStateSchema,
  assignedThreadId: z.string().nullable(),
  dispatchId: z.string().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.number(),
});

const rowSchema = z.object({
  schema: z.literal("afs"),
  schemaVersion: z.literal(AFS_VERSION),
  annotation: afsAnnotationSchema,
  projectId: z.string(),
  threadId: z.string(),
  reviewState: reviewStateSchema,
  workflowState: workflowStateSchema,
  routing: routingSchema,
  summary: z.string().nullable(),
  /** Stored screenshot kinds (presence only — fetch pixels separately). */
  screenshots: z.array(z.enum(screenshotKinds)),
  createdAt: z.number(),
  updatedAt: z.number(),
  guestPending: z.boolean(),
  guestFeedback: guestFeedbackSchema.nullable(),
});
const agentProfileSpawnOutputSchema = z.object({
  threadId: z.string(),
  environmentId: z.string().nullable(),
  profileId: z.string().uuid(),
  revision: z.number().int().positive(),
});

// Pre-flight reads (lib/provider-health.ts): the provider and model a saved
// profile would spawn with, and what the machine says about that account's
// quota. Both are `.loose()` because we consume three fields from schemas two
// other plugins own — a field they add must not fail our parse.
const agentProfileListOutputSchema = z.array(
  z
    .object({
      slug: z.string(),
      providerId: z.string(),
      model: z.string(),
    })
    .loose(),
);
const providerUsageOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      planLabel: z.string().nullable().optional(),
      windows: z.array(
        z
          .object({
            label: z.string(),
            usedPercent: z.number(),
            resetsAt: z.string().nullable(),
          })
          .loose(),
      ),
    })
    .loose(),
  z.object({ status: z.literal("not_installed") }).loose(),
  z.object({ status: z.literal("unauthenticated") }).loose(),
  z.object({ status: z.literal("expired") }).loose(),
  z.object({ status: z.literal("error"), message: z.string() }).loose(),
]);
const usageSnapshotOutputSchema = z
  .object({
    machines: z.array(
      z
        .object({
          id: z.string(),
          status: z.enum(["connected", "disconnected"]),
          providers: z.array(
            z
              .object({
                id: z.string(),
                displayName: z.string().optional(),
                usage: providerUsageOutputSchema.nullable(),
              })
              .loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();



/** One pinned piece of visual feedback, as delivered to the frontend/CLI. */
export type PinpointAnnotation = z.infer<typeof rowSchema>;

const integrationSchema = z.object({
  clasi: z.boolean().default(false),
  agents: z.boolean().default(false),
  providerUsage: z.boolean().default(false),
});

export const rpcContract = defineRpcContract({
  captureGuest: { input: guestCaptureInputSchema, output: guestCaptureReceiptSchema },
  listGuest: { input: guestReviewScopeSchema, output: z.object({ rows: z.array(guestRowSchema) }) },
  approveGuestFeedback: {
    input: guestFeedbackSchema.extend({ id: z.string() }).strict(),
    output: z.object({ row: rowSchema, warning: z.string().optional() }),
  },
  replyGuest: {
    input: guestRowInputSchema.extend({ text: z.string().trim().min(1).max(4_000) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  deleteGuest: { input: guestRowInputSchema, output: z.object({ ok: z.literal(true) }) },
  screenshotGuest: {
    input: guestRowInputSchema.extend({ kind: z.enum(screenshotKinds) }).strict(),
    output: z.object({ shot: z.object({ mime: z.string(), data: z.string() }).nullable() }),
  },
  uploadGuestScreenshot: {
    input: z.object({
      isolationVersion: z.literal(GUEST_PREVIEW_ISOLATION_VERSION),
      token: z.string().min(1), kind: z.enum(screenshotKinds),
      mime: z.enum(["image/webp", "image/png", "image/jpeg"]),
      screenshot: z.string().min(1).max(SCREENSHOT_MAX_BASE64_CHARS),
    }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  prepareGuestPickerLibrary: {
    input: z.object({
      isolationVersion: z.literal(GUEST_PREVIEW_ISOLATION_VERSION),
      targetUrl: z.string().url(), proxyBase: z.string().url(),
    }).strict(),
    output: preparedGuestResourceSchema,
  },
  uploadScreenshot: {
    input: z.object({
      threadId: z.string(), clientId: z.string().regex(/^pp_[a-z0-9]{4,24}$/),
      kind: z.enum(screenshotKinds), mime: z.enum(["image/webp", "image/png", "image/jpeg"]),
      screenshot: z.string().min(1).max(SCREENSHOT_MAX_BASE64_CHARS), url: z.string().url(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  integrations: { input: z.null(), output: integrationSchema },
  setIntegration: {
    input: z.object({ integration: z.enum(["clasi", "agents", "providerUsage"]), enabled: z.boolean() }).strict(),
    output: integrationSchema,
  },
  config: {
    input: z.null(),
    output: z.object({
      defaultUrl: z.string(),
      relayMode: z.enum(["thread", "review-chat"]),
      autoDispatch: z.boolean(),
      clasiLearning: z.boolean(),
      proxyBase: z.string(),
    }),
  },
  liveTarget: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ url: z.string().nullable() }),
  },
  setLiveTarget: {
    input: z
      .object({
        threadId: z.string(),
        url: z.string().url(),
        registrationId: z.string(),
        observedShareId: z.string().nullable(),
        observedRevision: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  clearLiveTarget: {
    input: z
      .object({ threadId: z.string(), registrationId: z.string() })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  navigateLiveTarget: {
    input: z
      .object({
        threadId: z.string(),
        url: z.string().url(),
        shareId: z.string(),
        revision: z.number().int().nonnegative(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  capture: {
    input: captureSchema,
    output: z.object({ row: rowSchema, dispatched: z.boolean(), captureId: z.string() }),
  },
  list: {
    input: z
      .object({ threadId: z.string(), status: workflowStateSchema.optional() })
      .strict(),
    output: z.object({ rows: z.array(rowSchema) }),
  },
  update: {
    input: z
      .object({
        id: z.string(),
        action: z.enum([
          "approve",
          "dismiss",
          "feedback",
          "redispatch",
          // Re-attempt the clasi write for an approved+consented learning
          // whose previous write failed.
          "retry-learning",
        ]),
        note: z.string().optional(),
        // Explicit learning opt-in for `approve` (R12/AE4): only `true`
        // records consent and triggers the clasi write. Absent/false writes
        // NOTHING and clears nothing.
        learning: z.boolean().optional(),
        approvedLearning: z.object({
          text: z.string(), topic: z.enum(learningTopics), logicalKey: z.string(),
        }).strict().optional(),
      })
      .strict(),
    // `warning` carries non-fatal delivery problems (agent busy, send failed)
    // so the panel can tell the user instead of silently dropping them.
    output: z.object({ row: rowSchema, warning: z.string().optional() }),
  },
  probe: {
    input: z.object({ url: z.string() }).strict(),
    output: z.object({ ok: z.boolean(), status: z.number().nullable() }),
  },
  remove: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  // Screenshot pixels for the panel thumbnail (base64; null when absent).
  prepareGuestProxy: {
    input: z
      .object({
        isolationVersion: z.literal(GUEST_PREVIEW_ISOLATION_VERSION),
        targetUrl: z.string().url(),
        proxyBase: z.string().url(),
        contentType: z.string(),
        bodyBase64: z.string(),
      })
      .strict(),
    output: preparedGuestResourceSchema,
  },
  publicReviewController: {
    input: z.null(),
    output: z.object({ script: z.string() }),
  },
  publicReviewStyles: {
    input: z.null(),
    output: z.object({ css: z.string() }),
  },
  screenshot: {
    input: z
      .object({ id: z.string(), kind: z.enum(screenshotKinds) })
      .strict(),
    output: z.object({
      shot: z.object({ mime: z.string(), data: z.string() }).nullable(),
    }),
  },
});

// ---------------------------------------------------------------------------
// Injected element picker (runs in the proxied page's own main world).
// Everything is event-driven so head injection is safe (no document.body use
// at load). Backslashes in regex are doubled for the template literal.
// ---------------------------------------------------------------------------
export const PICKER_JS = `
(function(){
  if(window.__pinpointInstalled) return; window.__pinpointInstalled=true;
  var AUTH; try{var ab=new Uint8Array(16);crypto.getRandomValues(ab);AUTH=Array.prototype.map.call(ab,function(v){return v.toString(16).padStart(2,'0');}).join('');}catch(_){AUTH=Date.now().toString(36)+Math.random().toString(36).slice(2);}
  function savedScreenshotPreference(){try{return localStorage.getItem('pinpoint.screenshots.enabled')!=='false';}catch(_){return true;}}
  var PP={active:false,persist:false,panelOpen:false,screenshots:savedScreenshotPreference(),confirmTextEdits:false,showElementOutline:false,reviewPermissions:null,suppressPickClick:false,annos:[],markers:{},popup:null,hi:null,tip:null,mtip:null,layer:null,cursor:null,curEl:null,reveal:null,revealPulse:null,pending:null,edit:null};
  var C={green:'#15803d',blue:'#1d4ed8',grey:'#52525b',amber:'#b45309'};
  function colorFor(s){ if(s==='ready')return C.blue; if(s==='waiting-input')return C.amber; if(s==='approved'||s==='dismissed')return C.grey; return C.green; }
  function injectStyle(){
    var s=document.createElement('style'); s.textContent=[
      '.pp-layer{position:fixed;inset:0;z-index:2147483600;pointer-events:none}',
      '.pp-hi{position:fixed;z-index:2147483601;pointer-events:none;border:2px solid '+C.blue+';background:transparent;border-radius:4px;display:none}',
      '.pp-tip{position:fixed;z-index:2147483647;pointer-events:none;font:11px ui-monospace,monospace;background:#161616;color:#fff;padding:2px 6px;border-radius:5px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none}',
      '.pp-cursor{position:fixed;z-index:2147483646;pointer-events:none;width:30px;height:30px;display:none;align-items:center;justify-content:center;border-radius:2px 15px 15px 15px;background:#1d4ed8;color:#fff;border:2px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,.28)}',
      '.pp-cursor svg{width:16px;height:16px;transform:translate(1px,-1px)}',
      '.pp-picking,.pp-picking *{cursor:none!important}',
      '.pp-mark{position:fixed;isolation:isolate;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:999px;opacity:1!important;color:#fff;font:600 11px/22px ui-sans-serif,system-ui;text-align:center;cursor:pointer;pointer-events:auto;transform:rotate(0deg);transition:border-radius .16s cubic-bezier(.77,0,.175,1),transform .16s cubic-bezier(.77,0,.175,1)}',
      '.pp-mark-num,.pp-mark-edit{position:absolute;z-index:1;inset:0;display:flex;align-items:center;justify-content:center;transition:opacity .12s cubic-bezier(.2,0,0,1),transform .12s cubic-bezier(.2,0,0,1),filter .12s cubic-bezier(.2,0,0,1)}',
      '@media (prefers-reduced-motion:reduce){.pp-mark{transition:none}}',
      '.pp-mark-edit{opacity:0;transform:scale(.25);filter:blur(4px)}',
      '.pp-mark:hover .pp-mark-num,.pp-mark:focus-visible .pp-mark-num{opacity:0;transform:scale(.25);filter:blur(4px)}',
      '.pp-mark:hover .pp-mark-edit,.pp-mark:focus-visible .pp-mark-edit{opacity:1;transform:scale(1);filter:blur(0)}',
      '.pp-mark.pp-offscreen{border-radius:50% 50% 3px 50%;transform:rotate(var(--pp-rotation,0deg))}',
      '.pp-mark.pp-offscreen .pp-mark-num{transform:rotate(var(--pp-counter-rotation,0deg))}',
      '.pp-mark.pp-offscreen:hover .pp-mark-num,.pp-mark.pp-offscreen:focus-visible .pp-mark-num{opacity:1;filter:none;transform:rotate(var(--pp-counter-rotation,0deg))}',
      '.pp-mark.pp-offscreen .pp-mark-edit{display:none}',
      '.pp-mark:focus-visible{outline:2px solid #fff;outline-offset:2px}',
      '.pp-reveal{pointer-events:none;animation:pp-pulse 1.1s ease-out infinite}',
      '@keyframes pp-pulse{0%{box-shadow:0 0 0 0 rgba(148,163,184,.55),0 0 0 1.5px rgba(255,255,255,.9)}70%{box-shadow:0 0 0 12px rgba(148,163,184,0),0 0 0 1.5px rgba(255,255,255,.9)}100%{box-shadow:0 0 0 0 rgba(148,163,184,0),0 0 0 1.5px rgba(255,255,255,.9)}}',
      '.pp-mtip{position:fixed;z-index:2147483647;pointer-events:none;max-width:260px;background:#161616;color:#e5e5e5;border:1px solid #2e2e2e;border-radius:8px;padding:6px 8px;box-shadow:0 8px 24px rgba(0,0,0,.5);font:12px/1.4 ui-sans-serif,system-ui;display:none}',
      '.pp-mtip .a{margin-top:4px;color:#9a9a9a;font-size:12px}',
      '.pp-pop{position:fixed;z-index:2147483647;box-sizing:border-box;display:flex;flex-direction:column;width:280px;max-height:min(72vh,640px);overflow:hidden;background:#161616!important;opacity:1!important;backdrop-filter:none;color:#e5e5e5;border:1px solid #2e2e2e;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6);padding:10px;font:13px/1.45 ui-sans-serif,system-ui;transform-origin:top left;animation:pp-in .16s cubic-bezier(.23,1,.32,1)}',
      '.pp-pop *{opacity:1!important}',
      '.pp-pop-view{width:min(360px,calc(100vw - 16px));overflow:visible;padding:0;background:transparent!important;border:0;box-shadow:none}',
      '@keyframes pp-in{from{transform:scale(.97)}to{transform:scale(1)}}',
      '.pp-pop .sel{flex:none;font:10px ui-monospace,monospace;color:#8a8a8a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px}',
      '.pp-convo{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#4a4a4a transparent;padding-right:4px;margin-right:-4px}',
      '.pp-pop-view .pp-convo{box-sizing:border-box;margin:0;padding:10px;background:#161616!important;border:1px solid #2e2e2e;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.6)}',
      '.pp-convo::-webkit-scrollbar{width:6px}',
      '.pp-convo::-webkit-scrollbar-button{display:none;width:0;height:0}',
      '.pp-convo::-webkit-scrollbar-track{background:transparent}',
      '.pp-convo::-webkit-scrollbar-thumb{background:#4a4a4a;border:2px solid transparent;border-radius:999px;background-clip:content-box}',
      '.pp-pop .human{background:transparent!important;border-radius:0;padding:6px 8px;margin-bottom:6px}',
      '.pp-pop .human b{display:block;color:#8a8a8a;font-size:9px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:2px}',
      '.pp-pop .human p{margin:0;font-size:13px;color:#f0f0f0;white-space:pre-wrap}',
      '.pp-pop .q{font-style:italic;color:#b8b8b8;font-size:12px;background:#1e1e1e;border-radius:6px;padding:6px 8px;margin-bottom:8px}',
      '.pp-pop .agent{background:#232323!important;border-radius:8px;padding:7px 9px;margin-bottom:8px}',
      '.pp-pop .agent b{display:block;color:#8a8a8a;font-size:9px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:2px}',
      '.pp-pop .agent.ask b{color:#b45309}',
      '.pp-pop .agent p{margin:0;font-size:12px;color:#c4c4c4;white-space:pre-wrap}',
      '.pp-pop-create{width:min(420px,calc(100vw - 16px));max-height:none;overflow:visible;padding:0;background:transparent!important;border:0;box-shadow:none}',
      '.pp-compose{display:flex;flex:none;align-items:flex-end;gap:8px;margin-top:8px;padding:0;background:transparent;border:0}',
      '.pp-pop-create .pp-compose{margin-top:0;opacity:1!important}',
      '.pp-pop textarea{box-sizing:border-box!important;flex:1;min-width:0;height:40px;resize:none;overflow-y:hidden;background:#171717!important;border:1px solid #262626!important;border-radius:20px!important;color:#f5f5f5!important;font:13px/20px ui-sans-serif,system-ui;padding:10px 14px!important;outline:none;scrollbar-width:thin;scrollbar-color:#525252 transparent}',
      '.pp-pop-view textarea{border:0!important;box-shadow:0 10px 28px rgba(0,0,0,.36)}',
      '.pp-pop-view .pp-del,.pp-pop-view .pp-act,.pp-pop-view .pp-send{box-shadow:0 10px 28px rgba(0,0,0,.36)}',
      '.pp-pop-create textarea{box-shadow:0 10px 28px rgba(0,0,0,.36)}',
      '.pp-pop textarea::placeholder{color:#6b6b6b!important}',
      '.pp-pop textarea::-webkit-scrollbar{width:8px}',
      '.pp-pop textarea::-webkit-scrollbar-button{display:none;width:0;height:0}',
      '.pp-pop textarea::-webkit-scrollbar-track{background:transparent}',
      '.pp-pop textarea::-webkit-scrollbar-thumb{background:#525252;border:2px solid transparent;border-radius:999px;background-clip:content-box}',
      '.pp-del,.pp-act,.pp-question,.pp-send{box-sizing:border-box!important;display:inline-flex;flex:none;width:40px!important;height:40px!important;align-items:center;justify-content:center;border:none;border-radius:20px!important;padding:0!important;cursor:pointer;line-height:0;transition:background .12s,color .12s,transform .12s ease-out}',
      '.pp-del,.pp-act{background:#171717!important;color:#737373!important;border:1px solid #262626!important}',
      '.pp-question{background:#171717!important;color:#f0f0f0!important;border:1px solid #262626!important}',
      '.pp-pop-create .pp-question,.pp-pop-create .pp-send{box-shadow:0 10px 28px rgba(0,0,0,.36)}',
      '.pp-del:hover,.pp-act:hover,.pp-question:hover{background:#262626!important;color:#f0f0f0!important}',
      '.pp-del:hover{color:#f87171!important}',
      '.pp-act.ok{color:#16a34a!important}',
      '.pp-act.ok:hover{background:#17351f!important}',
      '.pp-question[aria-pressed=true]{background:#171717!important;color:#f0f0f0!important}',
      '.pp-send{background:#171717!important;color:#f0f0f0!important;border:1px solid #262626!important}',
      '.pp-send:active{transform:scale(.96)}',
      '.pp-send[disabled]{background:#171717!important;color:#525252!important;border-color:#262626!important;cursor:default}',
      '.pp-editing{outline:2px dashed '+C.amber+'!important;outline-offset:2px;border-radius:2px;cursor:text}',
      '.pp-picking .pp-editing{cursor:text!important}',
      '.pp-pill{position:fixed;z-index:2147483647;display:flex;align-items:center;gap:8px;max-width:min(72vw,460px);background:#161616;color:#e5e5e5;border:1px solid #2e2e2e;border-radius:999px;padding:5px 6px 5px 12px;box-shadow:0 8px 24px rgba(0,0,0,.5);font:12px/1.4 ui-sans-serif,system-ui;animation:pp-in .16s cubic-bezier(.23,1,.32,1)}',
      '.pp-pill .pp-pill-diff{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pp-pill .pp-pill-diff s{color:#8a8a8a}',
      '.pp-pill .pp-pill-diff b{color:#f0f0f0;font-weight:600}',
      '.pp-pill button{flex:none;border:none;border-radius:999px;padding:4px 10px;font:600 11px ui-sans-serif,system-ui;cursor:pointer;transition:opacity .12s}',
      '.pp-pill .pp-pill-ok{background:#fff;color:#111}',
      '.pp-pill .pp-pill-no{background:#232323;color:#c4c4c4}',
      '.pp-pill .pp-pill-ok:hover{background:#e5e5e5}',
      '.pp-pill .pp-pill-no:hover{background:#303030}'
    ].join(''); document.documentElement.appendChild(s);
  }
  function ensure(){
    if(PP.layer) return;
    injectStyle();
    PP.layer=document.createElement('div'); PP.layer.className='pp-layer'; PP.layer.setAttribute('data-pinpoint-ui','');
    PP.hi=document.createElement('div'); PP.hi.className='pp-hi'; PP.hi.setAttribute('data-pinpoint-ui','');
    PP.tip=document.createElement('div'); PP.tip.className='pp-tip'; PP.tip.setAttribute('data-pinpoint-ui','');
    PP.mtip=document.createElement('div'); PP.mtip.className='pp-mtip'; PP.mtip.setAttribute('data-pinpoint-ui','');
    PP.cursor=document.createElement('div'); PP.cursor.className='pp-cursor'; PP.cursor.setAttribute('data-pinpoint-ui','');
    PP.cursor.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3 1.4-5A8.5 8.5 0 1 1 21 12Z"/></svg>';
    document.documentElement.appendChild(PP.layer);
    document.documentElement.appendChild(PP.hi);
    document.documentElement.appendChild(PP.tip);
    document.documentElement.appendChild(PP.mtip);
    document.documentElement.appendChild(PP.cursor);
  }
  function esc(s){ try{return CSS.escape(s);}catch(_){return s;} }
  function selectorFor(el){
    if(!el||el===document.body||el===document.documentElement) return 'body';
    if(el.id){ var idSel='#'+esc(el.id); try{ if(document.querySelectorAll(idSel).length===1) return idSel; }catch(_){} }
    var parts=[],n=el,depth=0;
    while(n&&n.nodeType===1&&n!==document.body&&n!==document.documentElement&&depth<10){
      if(n.id){ var s2='#'+esc(n.id); try{ if(document.querySelectorAll(s2).length===1){ parts.unshift(s2); break; } }catch(_){} }
      var seg=n.tagName.toLowerCase();
      if(n.classList&&n.classList.length){
        var cl=Array.prototype.slice.call(n.classList).filter(function(c){return c.indexOf('pp-')!==0;}).slice(0,3).map(esc);
        if(cl.length) seg+='.'+cl.join('.');
      }
      var p=n.parentElement;
      if(p){
        // Disambiguate among same-tag siblings so paragraphs sharing a class
        // don't all collapse onto the first match.
        var same=Array.prototype.filter.call(p.children,function(c){return c.tagName===n.tagName;});
        if(same.length>1) seg+=':nth-of-type('+(Array.prototype.indexOf.call(same,n)+1)+')';
      }
      parts.unshift(seg); n=p; depth++;
    }
    return parts.join(' > ');
  }
  function pathFor(el){
    var parts=[],n=el;
    while(n&&n.nodeType===1&&n!==document.documentElement){
      var s=n.tagName.toLowerCase();
      if(n.id) s+='#'+n.id; else if(n.classList&&n.classList.length) s+='.'+Array.prototype.slice.call(n.classList).join('.');
      parts.unshift(s); n=n.parentElement;
    }
    return parts.join(' > ');
  }
  function componentFor(el){
    var n=el;
    for(var i=0;i<8&&n;i++){
      if(n.getAttribute){ var d=n.getAttribute('data-component')||n.getAttribute('data-testid'); if(d) return d; }
      var key=Object.keys(n).find(function(k){return k.indexOf('__reactFiber$')===0||k.indexOf('__reactInternalInstance$')===0;});
      if(key){ var f=n[key]; while(f){ var t=f.type; if(t&&typeof t!=='string'){var nm=t.displayName||t.name; if(nm) return nm;} f=f.return; } }
      n=n.parentElement;
    }
    return null;
  }
  function targetLoc(){
    try{
      if(window.__pinpointTargetUrl)return window.__pinpointTargetUrl();
    }catch(_){}
    var b=document.querySelector('base'); var href=b&&b.href?b.href:location.href;
    try{return new URL(href);}catch(_){return location;}
  }
  // ---- capture enrichment (all optional; sizes capped at capture time) ----
  function styleFor(el){
    try{
      var cs=window.getComputedStyle(el); if(!cs)return null;
      var props=['display','position','width','height','margin','padding','color','background-color','font-family','font-size','font-weight','line-height','border-radius','z-index','flex-direction'];
      var out=[];
      props.forEach(function(p){
        var v=cs.getPropertyValue(p); if(!v)return; v=String(v).trim();
        // Skip empty/default values so the summary stays small.
        if(!v||v==='auto'||v==='none'||v==='normal'||v==='0px'||v==='rgba(0, 0, 0, 0)'||v==='transparent')return;
        out.push(p+':'+v);
      });
      return out.length?out.join('; ').slice(0,500):null;
    }catch(_){return null;}
  }
  function axFor(el){
    try{
      var role=el.getAttribute('role');
      if(!role){
        var t=el.tagName.toLowerCase();
        var implicit={button:'button',select:'listbox',textarea:'textbox',img:'img',nav:'navigation',main:'main',header:'banner',footer:'contentinfo',form:'form',h1:'heading',h2:'heading',h3:'heading',h4:'heading',h5:'heading',h6:'heading',ul:'list',ol:'list',li:'listitem',table:'table'};
        if(t==='a'&&el.getAttribute('href'))role='link';
        else if(t==='input')role=(el.getAttribute('type')==='checkbox')?'checkbox':'textbox';
        else role=implicit[t]||null;
      }
      var name=el.getAttribute('aria-label')||'';
      if(!name){
        var lb=el.getAttribute('aria-labelledby');
        if(lb){var ref=document.getElementById(lb.split(/\\s+/)[0]);if(ref)name=(ref.textContent||'').replace(/\\s+/g,' ').trim();}
      }
      if(!name)name=el.getAttribute('alt')||el.getAttribute('title')||'';
      var parts=[];
      if(role)parts.push('role='+role);
      if(name)parts.push('name="'+name.slice(0,60)+'"');
      Array.prototype.forEach.call(el.attributes,function(a){
        if(a.name.indexOf('aria-')===0&&a.name!=='aria-label'&&a.name!=='aria-labelledby')parts.push(a.name+'='+String(a.value).slice(0,30));
      });
      return parts.length?parts.join(' ').slice(0,200):null;
    }catch(_){return null;}
  }
  function descFor(n){
    if(!n||n.nodeType!==1||isOurs(n))return null;
    var s=n.tagName.toLowerCase();
    if(n.id)s+='#'+n.id;
    else if(n.classList&&n.classList.length)s+='.'+Array.prototype.slice.call(n.classList).filter(function(c){return c.indexOf('pp-')!==0;}).slice(0,2).join('.');
    var t=(n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40);
    return t?s+' "'+t+'"':s;
  }
  function nearFor(el){
    try{
      var cands=[el.previousElementSibling,el.nextElementSibling,el.parentElement,
        el.parentElement&&el.parentElement.previousElementSibling,
        el.parentElement&&el.parentElement.nextElementSibling];
      var out=[];
      cands.forEach(function(n){ if(out.length>=5)return; var d=descFor(n); if(d)out.push(d); });
      return out.length?out.join(' | ').slice(0,300):null;
    }catch(_){return null;}
  }
  function payloadFor(el,cx,cy){
    var cls=el.classList?Array.prototype.slice.call(el.classList):[];
    var near=(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160);
    var loc=targetLoc();
    // The annotation id is generated HERE so the element can be stamped with
    // a durable data-pp anchor at pick time; the server adopts it as the row
    // id when valid (same pp_ format it generates itself).
    var clientId='pp_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    try{el.setAttribute('data-pp',clientId);}catch(_){}
    var rect=null;
    try{var b=el.getBoundingClientRect();rect={x:b.left,y:b.top,w:b.width,h:b.height};}catch(_){}
    var offsetX=null,offsetY=null;
    if(rect){offsetX=Math.max(0,Math.min(cx-rect.x,rect.w));offsetY=Math.max(0,Math.min(cy-rect.y,rect.h));}
    return {clientId:clientId,selector:selectorFor(el),elementPath:pathFor(el),tag:el.tagName.toLowerCase(),cssClasses:cls,
      componentName:componentFor(el),nearbyText:near,url:loc.href,pathname:loc.pathname,title:document.title,
      rect:rect,computedStyles:styleFor(el),accessibility:axFor(el),nearbyElements:nearFor(el),
      x:cx+(window.scrollX||0),y:cy+(window.scrollY||0),anchorOffsetX:offsetX,anchorOffsetY:offsetY,
      screenshotExpected:PP.screenshots};
  }
  function post(m){ m.source='bb-pinpoint'; m.authToken=AUTH; try{ window.parent.postMessage(m,'*'); }catch(_){} }
  // ---- screenshots (fire-and-forget; every failure silently skips) ----
  // Capture only the selected element. Rasterizing documentElement clones and
  // paints the entire page on the UI thread, which freezes complex sites.
  // Keep the output's long edge at or below 1600px.
  function encodeShot(canvas){
    try{
      var d=canvas.toDataURL('image/webp',0.8);
      if(d.indexOf('data:image/webp')!==0)d=canvas.toDataURL('image/png');
      var i=d.indexOf(',');if(i<0)return null;
      return {mime:(d.slice(5,d.indexOf(';'))||'image/png'),b64:d.slice(i+1)};
    }catch(_){return null;}
  }
  function postShot(clientId,kind,canvas){
    try{
      var enc=encodeShot(canvas);if(!enc||!enc.b64)return;
      post({type:'screenshot-upload',clientId:clientId,kind:kind,mime:enc.mime,screenshot:enc.b64,url:targetLoc().href});
    }catch(_){}
  }
  function screenshotTarget(el){
    try{
      return el.closest('button,a[href],[role="button"],[role="link"],label,input,select,textarea')||el;
    }catch(_){return el;}
  }
  function captureShots(payload){
    try{
      var sd=window.snapdom;
      if(!sd||!sd.toCanvas||!payload||!payload.clientId)return;
      var el=document.querySelector('[data-pp="'+esc(payload.clientId)+'"]');
      if(!el)return;
      el=screenshotTarget(el);
      var r=el.getBoundingClientRect(),long=Math.max(r.width,r.height);
      var scale=long>1600?1600/long:1;
      sd.toCanvas(el,{scale:scale,dpr:1,fast:true,backgroundColor:'#fff'}).then(function(canvas){
        try{ if(canvas&&canvas.width)postShot(payload.clientId,'element',canvas); }catch(_){}
      }).catch(function(){});
    }catch(_){}
  }
  // ---- markers ----
  // Re-anchor order: [data-pp="<id>"] (durable, survives selector drift) →
  // stored CSS selector (stamping data-pp for next time) → null (caller
  // falls back to x/y coordinates). Among duplicate data-pp matches, prefer
  // the one that also satisfies the stored selector.
  function elForAnno(a){
    if(a.id){
      try{
        var list=document.querySelectorAll('[data-pp="'+esc(a.id)+'"]');
        if(list.length){
          var hit=list[0];
          if(list.length>1&&a.selector){
            for(var i=0;i<list.length;i++){
              try{ if(list[i].matches&&list[i].matches(a.selector)){ hit=list[i]; break; } }catch(_){}
            }
          }
          return hit;
        }
      }catch(_){}
    }
    if(a.selector){
      try{
        var el=document.querySelector(a.selector);
        if(el){
          try{ if(a.id&&!el.getAttribute('data-pp'))el.setAttribute('data-pp',a.id); }catch(_){}
          return el;
        }
      }catch(_){}
    }
    return null;
  }
  function place(mark,a,occupied){
    var el=elForAnno(a),x,y;
    if(el){ var r=el.getBoundingClientRect();
      if(typeof a.anchorOffsetX==='number'&&typeof a.anchorOffsetY==='number'){
        x=r.left+Math.max(0,Math.min(a.anchorOffsetX,r.width));
        y=r.top+Math.max(0,Math.min(a.anchorOffsetY,r.height));
      } else { x=r.left; y=r.top; }
    }
    else if(typeof a.x==='number'){ x=a.x-(window.scrollX||0); y=a.y-(window.scrollY||0); }
    else { mark.style.display='none'; return; }
    var targetX=x,targetY=y;
    var slot=0;
    if(occupied){
      var key=Math.round(x)+':'+Math.round(y); slot=occupied[key]||0; occupied[key]=slot+1;
    }
    var radius=11,edge=18,vw=window.innerWidth||0,vh=window.innerHeight||0;
    var min=radius+edge;
    if(vw)x=Math.max(min,Math.min(x,vw-min));
    if(vh)y=Math.max(min,Math.min(y,vh-min));
    if(slot){
      x+=(targetX>(vw||0)/2?-1:1)*slot*24;
      if(vw)x=Math.max(min,Math.min(x,vw-min));
    }
    var offscreen=(vw&&(targetX<min||targetX>vw-min))||(vh&&(targetY<min||targetY>vh-min));
    mark.classList.toggle('pp-offscreen',!!offscreen);
    if(offscreen){
      var angle=Math.atan2(targetY-y,targetX-x)*180/Math.PI;
      var rotation=angle-45;
      mark.style.setProperty('--pp-angle',angle+'deg');
      mark.style.setProperty('--pp-rotation',rotation+'deg');
      mark.style.setProperty('--pp-counter-rotation',-rotation+'deg');
    } else {
      mark.style.removeProperty('--pp-angle');
      mark.style.removeProperty('--pp-rotation');
      mark.style.removeProperty('--pp-counter-rotation');
    }
    mark.style.display=''; mark.style.left=x+'px'; mark.style.top=y+'px';
  }
  function showMTip(a,m){
    var r=m.getBoundingClientRect(); PP.mtip.innerHTML='';
    var q=document.createElement('div'); q.textContent=a.comment||'(no comment)'; PP.mtip.appendChild(q);
    if(a.summary){ var ab=document.createElement('div'); ab.className='a'; ab.textContent='Agent: '+a.summary; PP.mtip.appendChild(ab); }
    PP.mtip.style.display='block';
    PP.mtip.style.left=Math.max(4,Math.min(r.left,window.innerWidth-266))+'px';
    PP.mtip.style.top=(r.bottom+6)+'px';
  }
  function renderMarkers(){
    ensure(); var seen={},occupied={};
    PP.annos.forEach(function(a){
      if(PP.pending&&PP.pending.__id===a.id)clearPending();
      seen[a.id]=1; var m=PP.markers[a.id];
      if(!m){
        m=document.createElement('div'); m.className='pp-mark'; m.setAttribute('role','button'); m.setAttribute('tabindex','0'); m.setAttribute('aria-label','Open comment');
        m.innerHTML='<span class="pp-mark-num"></span><span class="pp-mark-edit" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></span>';
        m.__num=m.querySelector('.pp-mark-num'); PP.layer.appendChild(m); PP.markers[a.id]=m;
        m.addEventListener('mouseenter',function(){ showMTip(m.__a,m); });
        m.addEventListener('mouseleave',function(){ PP.mtip.style.display='none'; });
        function openMarker(e){ e.preventDefault(); e.stopPropagation(); if(PP.active)setActive(false); var r=m.getBoundingClientRect(); openPopup(null,r.left,r.bottom+8,m.__a); }
        m.addEventListener('click',openMarker);
        m.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ openMarker(e); } });
      }
      m.__a=a; m.__num.textContent=a.index; m.setAttribute('aria-label','Open comment '+a.index); m.style.background=colorFor(a.status);
      m.style.boxShadow='0 0 0 1.5px rgba(255,255,255,.9),0 2px 8px rgba(0,0,0,.4)';
      place(m,a,occupied);
    });
    Object.keys(PP.markers).forEach(function(id){ if(!seen[id]){ PP.markers[id].remove(); delete PP.markers[id]; } });
  }
  function reposition(){ var occupied={}; Object.keys(PP.markers).forEach(function(id){ place(PP.markers[id],PP.markers[id].__a,occupied); }); if(PP.reveal) place(PP.reveal,PP.reveal.__a); }
  function clearReveal(){ if(PP.reveal){ PP.reveal.remove(); PP.reveal=null; } if(PP.revealPulse){ PP.revealPulse.classList.remove('pp-reveal'); PP.revealPulse=null; } }
  function revealAnno(a){
    ensure(); clearReveal();
    var el=elForAnno(a);
    if(el&&el.scrollIntoView){ try{ el.scrollIntoView({block:'center',inline:'center'}); }catch(_){ el.scrollIntoView(); } }
    else if(typeof a.y==='number'){ window.scrollTo(0,Math.max(0,a.y-(window.innerHeight/2))); }
    var resolved=a.status==='approved'||a.status==='dismissed';
    var existing=PP.markers[a.id];
    if(existing){ if(resolved){ existing.classList.add('pp-reveal'); PP.revealPulse=existing; } reposition(); return; }
    if(!resolved)return;
    var m=document.createElement('div'); m.className='pp-mark pp-reveal'; m.textContent=a.index||''; m.style.background=colorFor(a.status); m.__a=a; PP.layer.appendChild(m); PP.reveal=m; place(m,a);
  }
  // ---- popup (create when payload, view/reply when viewData) ----
  function closePopup(keepPending){ if(!keepPending)clearPending(); if(PP.popup){ PP.popup.remove(); PP.popup=null; if(PP.persist) setActive(true,keepPending); } }
  function clearPending(){ if(PP.pending){ PP.pending.remove(); PP.pending=null; } }
  function showPending(x,y,id){ ensure(); clearPending(); var m=document.createElement('div'); m.className='pp-mark'; m.textContent='+'; m.__id=id; m.style.background=C.green; m.style.boxShadow='0 0 0 1.5px rgba(255,255,255,.9),0 2px 8px rgba(0,0,0,.4)'; m.style.left=x+'px'; m.style.top=y+'px'; PP.layer.appendChild(m); PP.pending=m; }
  function openPopup(payload,x,y,viewData){
    closePopup(); ensure();
    var pop=document.createElement('div'); pop.className='pp-pop '+(viewData?'pp-pop-view':'pp-pop-create'); pop.setAttribute('data-pinpoint-ui',''); PP.popup=pop;
    var convo=document.createElement('div'); convo.className='pp-convo';
    var quote=(viewData&&viewData.selectedText)||(payload&&payload.selectedText);
    if(quote){ var qd=document.createElement('div'); qd.className='q'; qd.textContent='\\u201C'+quote+'\\u201D'; convo.appendChild(qd); }
    if(viewData){
      var thread=(viewData.thread&&viewData.thread.length)?viewData.thread:null;
      var msgs=thread||(viewData.comment?[{role:viewData.authoredByAgent?'agent':'human',content:viewData.comment,guest:viewData.authoredByGuest===true}]:[]);
      msgs.forEach(function(mm,mi){
        if(mm.role==='agent'){
          var asking=viewData.status==='waiting-input'&&mi===msgs.length-1;
          var ag=document.createElement('div'); ag.className='agent'+(asking?' ask':'');
          var ab=document.createElement('b'); ab.textContent=asking?'Agent asks':'Agent';
          var ap=document.createElement('p'); ap.textContent=mm.content;
          ag.appendChild(ab); ag.appendChild(ap); convo.appendChild(ag);
        } else {
          var hu=document.createElement('div'); hu.className='human';
          var hb=document.createElement('b'); hb.textContent=mm.guest?(mm.ownerEdited?'Guest · edited':'Guest'):'You';
          var hp=document.createElement('p'); hp.textContent=mm.content;
          hu.appendChild(hb); hu.appendChild(hp); convo.appendChild(hu);
        }
      });
    }
    if(convo.childNodes.length)pop.appendChild(convo);
    var row=document.createElement('div'); row.className='pp-compose';
    var CHK='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    if(viewData){
      var del=document.createElement('button'); del.type='button'; del.className='pp-del'; del.title='Delete'; del.setAttribute('aria-label','Delete');
      del.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
      del.onclick=function(){ post({type:'intent',id:viewData.id,action:'delete'}); closePopup(); };
      if(!PP.reviewPermissions||(PP.reviewPermissions.delete&&viewData.guestCanDelete))row.appendChild(del);
      if(!PP.reviewPermissions&&!viewData.guestPending&&viewData.status==='ready'){
        var ap=document.createElement('button'); ap.type='button'; ap.className='pp-act ok'; ap.title='Approve'; ap.setAttribute('aria-label','Approve'); ap.innerHTML=CHK;
        ap.onclick=function(){ post({type:'intent',id:viewData.id,action:'approve'}); closePopup(); };
        row.appendChild(ap);
      }
      if(!PP.reviewPermissions&&viewData.guestPending){
        var edit=document.createElement('button'); edit.type='button'; edit.className='pp-act'; edit.style.flex='1'; edit.style.width='auto'; edit.title='Edit'; edit.setAttribute('aria-label','Edit'); edit.textContent='Edit';
        edit.onclick=function(){ post({type:'intent',id:viewData.id,action:'edit-guest'}); closePopup(); }; row.appendChild(edit);
        var approve=document.createElement('button'); approve.type='button'; approve.className='pp-act ok'; approve.title='Approve guest feedback'; approve.setAttribute('aria-label','Approve guest feedback'); approve.innerHTML=CHK;
        approve.onclick=function(){ post({type:'intent',id:viewData.id,action:'approve-guest'}); closePopup(); }; row.appendChild(approve);
        pop.appendChild(row); document.documentElement.appendChild(pop); positionPopup(); return;
      }
    }
    var ta=document.createElement('textarea'); ta.rows=1; ta.placeholder=viewData?(viewData.status==='waiting-input'?'Answer…':'Add feedback…'):'What should change?'; row.appendChild(ta);
    if(!viewData&&payload){
      payload.intent=payload.intent==='question'?'question':'fix'; payload.severity='suggestion';
      var WRITING_ICON='<svg data-mode-icon="writing" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
      var QUESTION_ICON='<svg data-mode-icon="question" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9.7 9.7 0 0 1-4-.8L3 21l1.7-4.2A8.4 8.4 0 0 1 3 11.5 8.7 8.7 0 0 1 12 3a8.7 8.7 0 0 1 9 8.5Z"/><path d="M8 12h.01M12 12h.01M16 12h.01"/></svg>';
      var question=document.createElement('button'); question.type='button'; question.className='pp-question';
      function syncQuestion(){ var on=payload.intent==='question'; question.innerHTML=on?QUESTION_ICON:WRITING_ICON; question.setAttribute('aria-pressed',on?'true':'false'); question.title=on?'Switch to writing mode':'Switch to question mode'; question.setAttribute('aria-label',(on?'Question':'Writing')+' mode; '+question.title.toLowerCase()); ta.placeholder=on?'Ask a question…':'What should change?'; }
      question.onclick=function(e){ e.preventDefault(); e.stopPropagation(); payload.intent=payload.intent==='question'?'fix':'question'; syncQuestion(); };
      syncQuestion(); row.appendChild(question);
    }
    var send=document.createElement('button'); send.type='button'; send.className='pp-send'; send.disabled=true; send.title=viewData?'Reply':'Send'; send.setAttribute('aria-label',viewData?'Reply':'Send');
    if(viewData&&PP.reviewPermissions&&!PP.reviewPermissions.reply){ta.hidden=true;send.hidden=true;}
    send.innerHTML='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>';
    function submit(){ var t=ta.value.trim(); if(!t)return; if(viewData){ post({type:'intent',id:viewData.id,action:'reply',text:t}); closePopup(); } else { payload.comment=t; post({type:'pick',payload:payload}); closePopup(true); if(payload.screenshotExpected)setTimeout(function(){captureShots(payload);},60); } }
    function positionPopup(){ var vw=window.innerWidth||800,vh=window.innerHeight||600,w=pop.offsetWidth||280,h=pop.offsetHeight||48; pop.style.left=Math.max(8,Math.min(x,vw-w-8))+'px'; pop.style.top=Math.max(8,Math.min(y,vh-h-8))+'px'; }
    function resizeTextarea(){ var viewportLimit=Math.max(40,(window.innerHeight||600)-16); var limit=viewData?Math.min(160,viewportLimit):viewportLimit; ta.style.height='40px'; var needed=Math.max(40,ta.scrollHeight); var next=Math.min(limit,needed); ta.style.height=next+'px'; ta.style.overflowY=needed>limit?'auto':'hidden'; if(pop.isConnected)positionPopup(); }
    ta.addEventListener('input',function(){ send.disabled=!ta.value.trim(); resizeTextarea(); });
    ta.addEventListener('keydown',function(e){ e.stopPropagation(); if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); submit(); } else if(e.key==='Escape'){ e.preventDefault(); closePopup(); } });
    send.onclick=submit; row.appendChild(send); pop.appendChild(row);
    document.documentElement.appendChild(pop);
    resizeTextarea(); positionPopup();
    setTimeout(function(){ try{ta.focus();}catch(_){} },30);
  }
  // ---- direct text editing (comment mode, R4) ----
  // Right-click text while commenting -> contentEditable inline edit. Enter or
  // blur commits the ATTEMPT: a confirm pill shows old -> new; only Confirm
  // captures (accidental edits are never auto-dispatched). Escape / clicking
  // outside the pill discards and restores the original text. On confirm the
  // edited text stays in the page as a live preview (a reload re-renders from
  // source until the agent makes the change permanent).
  function capT(s){ s=s==null?'':String(s); return s.slice(0,500); }
  function pillTrunc(s,n){ s=String(s==null?'':s).replace(/\\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1)+'\\u2026':(s||'(empty)'); }
  function editText(el){ try{if(typeof el.innerText==='string')return el.innerText;}catch(_){} return el.textContent||''; }
  function snapshotChildren(el){
    var out=[];
    for(var i=0;i<el.childNodes.length;i++){
      var node=el.childNodes[i];
      out.push({node:node,value:(node.nodeType===3||node.nodeType===8)?node.nodeValue:null});
    }
    return out;
  }
  function restoreChildren(ed){
    while(ed.el.firstChild)ed.el.removeChild(ed.el.firstChild);
    for(var i=0;i<ed.origChildren.length;i++){
      var saved=ed.origChildren[i];
      if(saved.value!==null)saved.node.nodeValue=saved.value;
      ed.el.appendChild(saved.node);
    }
  }
  function editableTextTree(el){
    var inline=/^(ABBR|B|BDI|BDO|CITE|CODE|DATA|DEL|DFN|EM|I|INS|KBD|MARK|Q|S|SAMP|SMALL|SPAN|STRONG|SUB|SUP|TIME|U|VAR)$/i;
    for(var i=0;i<el.childNodes.length;i++){
      var child=el.childNodes[i];
      if(child.nodeType===3||child.nodeType===8)continue;
      if(child.nodeType!==1)return false;
      if(/^(BR|SVG)$/i.test(child.tagName))continue;
      if(!inline.test(child.tagName)||!editableTextTree(child))return false;
    }
    return true;
  }
  function editableFor(node){
    var el=node&&node.nodeType===3?node.parentElement:node;
    if(!el||el.nodeType!==1||isOurs(el))return null;
    var t=el.tagName; if(t==='INPUT'||t==='TEXTAREA'||t==='SELECT'||t==='OPTION')return null;
    if(el.getAttribute&&el.getAttribute('contenteditable'))return null;
    // Preserve safe inline formatting while editing prose. Structural or
    // interactive descendants stay on the normal comment path so editing a
    // paragraph cannot flatten controls or layout containers.
    var kids=el.childNodes; if(!kids.length||!editableTextTree(el))return null;
    if(!(el.textContent||'').trim())return null;
    return el;
  }
  function endEdit(){
    var ed=PP.edit; if(!ed)return; PP.edit=null;
    try{ed.el.removeAttribute('contenteditable');}catch(_){}
    try{ed.el.classList.remove('pp-editing');}catch(_){}
    try{ed.el.removeEventListener('blur',ed.onBlur);}catch(_){}
    if(ed.pill){ try{ed.pill.remove();}catch(_){} ed.pill=null; }
  }
  function discardEdit(){
    var ed=PP.edit; if(!ed)return;
    try{restoreChildren(ed);}catch(_){try{ed.el.textContent=ed.orig;}catch(__){}}
    endEdit();
  }
  function confirmEdit(){
    var ed=PP.edit; if(!ed)return;
    var r; try{r=ed.el.getBoundingClientRect();}catch(_){r={left:0,top:0};}
    var p=payloadFor(ed.el,r.left||0,r.top||0);
    p.kind='text-edit'; p.textOld=capT(ed.orig); p.textNew=capT(ed.newText);
    p.intent='fix';
    endEdit(); // the edited text stays visible — live preview
    p.screenshotExpected=false;
    post({type:'pick',payload:p});
  }
  function showEditPill(ed){
    ensure();
    var pill=document.createElement('div'); pill.className='pp-pill'; pill.setAttribute('data-pinpoint-ui',''); ed.pill=pill;
    var diff=document.createElement('span'); diff.className='pp-pill-diff';
    var o=document.createElement('s'); o.textContent=pillTrunc(ed.orig,60);
    var nn=document.createElement('b'); nn.textContent=pillTrunc(ed.newText,60);
    diff.appendChild(o); diff.appendChild(document.createTextNode(' \\u2192 ')); diff.appendChild(nn);
    pill.appendChild(diff);
    var ok=document.createElement('button'); ok.type='button'; ok.className='pp-pill-ok'; ok.textContent='Confirm'; ok.setAttribute('aria-label','Confirm text edit');
    ok.addEventListener('click',function(e){ e.preventDefault(); e.stopPropagation(); confirmEdit(); });
    var no=document.createElement('button'); no.type='button'; no.className='pp-pill-no'; no.textContent='Discard'; no.setAttribute('aria-label','Discard text edit');
    no.addEventListener('click',function(e){ e.preventDefault(); e.stopPropagation(); discardEdit(); });
    pill.appendChild(ok); pill.appendChild(no);
    document.documentElement.appendChild(pill);
    var r; try{r=ed.el.getBoundingClientRect();}catch(_){r={left:8,bottom:8};}
    var w=pill.offsetWidth||260;
    pill.style.left=Math.max(8,Math.min(r.left,(window.innerWidth||800)-w-8))+'px';
    pill.style.top=Math.max(8,r.bottom+6)+'px';
  }
  function commitEditAttempt(){
    var ed=PP.edit; if(!ed||!ed.editing)return;
    ed.editing=false;
    ed.newText=editText(ed.el);
    try{ed.el.removeAttribute('contenteditable');}catch(_){}
    try{ed.el.classList.remove('pp-editing');}catch(_){}
    try{if(ed.el.blur)ed.el.blur();}catch(_){}
    if(ed.newText===ed.orig){ endEdit(); return; }
    if(PP.confirmTextEdits)showEditPill(ed);else confirmEdit();
  }
  function startEdit(el){
    if(PP.reviewPermissions&&!PP.reviewPermissions.capture)return;
    ensure(); clearHover(); hideCursor(); if(PP.edit)discardEdit();
    var ed={el:el,orig:editText(el),origChildren:snapshotChildren(el),newText:null,editing:true,pill:null,onBlur:null};
    ed.onBlur=function(){ if(PP.edit===ed&&ed.editing)commitEditAttempt(); };
    PP.edit=ed;
    try{el.setAttribute('contenteditable','plaintext-only');}catch(_){}
    try{ if(el.contentEditable!=='plaintext-only')el.setAttribute('contenteditable','true'); }catch(_){ try{el.setAttribute('contenteditable','true');}catch(__){} }
    el.classList.add('pp-editing');
    el.addEventListener('blur',ed.onBlur);
    try{el.focus();}catch(_){}
  }
  function contextmenu(e){
    if(!PP.active&&!PP.persist&&!PP.popup&&!PP.edit)return;
    if(isOurs(e.target))return;
    e.preventDefault(); e.stopPropagation();
    if(PP.popup||PP.edit)return;
    var el=editableFor(e.target); if(!el)return;
    startEdit(el);
  }
  document.addEventListener('contextmenu',contextmenu,true);
  // While the confirm pill shows, any press outside it discards the edit.
  document.addEventListener('mousedown',function(e){
    if(!PP.edit||PP.edit.editing)return;
    if(e.target&&e.target.closest&&e.target.closest('.pp-pill'))return;
    PP.suppressPickClick=true;
    discardEdit();
  },true);
  // A nested Pinpoint review can render its own toolbar inside this frame.
  // Treat every Pinpoint-owned surface as chrome, never as review content.
  function isOurs(el){ return el&&el.closest&&el.closest('[data-pinpoint-ui]'); }
  function clearHover(){ if(PP.curEl===null)return; if(PP.hi)PP.hi.style.display='none'; if(PP.tip)PP.tip.style.display='none'; PP.curEl=null; }
  function hideCursor(){ if(PP.cursor)PP.cursor.style.display='none'; }
  function showCursor(e){ if(!PP.cursor)return; PP.cursor.style.display='flex'; PP.cursor.style.left=e.clientX+'px'; PP.cursor.style.top=e.clientY+'px'; }
  function positionHover(){
    var el=PP.curEl; if(!el||!el.isConnected){ clearHover(); return; }
    var r=el.getBoundingClientRect();
    PP.hi.style.display=PP.showElementOutline?'block':'none'; PP.hi.style.left=r.left+'px'; PP.hi.style.top=r.top+'px'; PP.hi.style.width=r.width+'px'; PP.hi.style.height=r.height+'px';
    PP.tip.style.display='block'; PP.tip.style.left=r.left+'px'; PP.tip.style.top=Math.max(0,r.top-20)+'px';
    PP.tip.textContent=el.tagName.toLowerCase()+(el.id?'#'+el.id:(el.classList&&el.classList.length?'.'+el.classList[0]:''));
  }
  function move(e){
    if(!PP.active||PP.edit){ hideCursor(); return; } if(isOurs(e.target)){ clearHover(); hideCursor(); return; } showCursor(e); var el=document.elementFromPoint(e.clientX,e.clientY);
    if(!el||el===PP.hi||el===PP.tip)return; if(isOurs(el)){ clearHover(); hideCursor(); return; }
    PP.curEl=el; positionHover();
  }
  function click(e){
    if(PP.suppressPickClick){ PP.suppressPickClick=false; e.preventDefault(); e.stopPropagation(); return; }
    if(!PP.active||PP.edit)return; if(isOurs(e.target))return;
    e.preventDefault(); e.stopPropagation();
    var el=PP.curEl||document.elementFromPoint(e.clientX,e.clientY); if(!el)return;
    var payload=payloadFor(el,e.clientX,e.clientY); setActive(false); openPopup(payload,e.clientX+8,e.clientY+8,null); showPending(e.clientX,e.clientY,payload.clientId);
  }
  function selUp(){
    if(!PP.active||PP.edit)return;
    var s=window.getSelection&&window.getSelection(); var t=s?String(s):''; t=t.replace(/\\s+/g,' ').trim();
    if(!t)return;
    var node=s.anchorNode; var el=node?(node.nodeType===1?node:node.parentElement):null;
    if(!el||isOurs(el))return;
    var r; try{ r=s.getRangeAt(0).getBoundingClientRect(); }catch(_){ r=el.getBoundingClientRect(); }
    setActive(false);
    var p=payloadFor(el,r.left,r.top); p.selectedText=t.slice(0,200);
    openPopup(p,r.left+8,r.bottom+8,null);
    showPending(r.left,r.top,p.clientId);
  }
  function editableTarget(){ var a=document.activeElement; return !!(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable)); }
  function key(e){ if(PP.edit){ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); discardEdit(); } else if(PP.edit.editing&&e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); e.stopPropagation(); commitEditAttempt(); } return; } if(PP.popup&&e.key==='Escape'){ e.preventDefault(); closePopup(); return; } if(PP.active&&e.key==='Escape'){ PP.persist=false; setActive(false); post({type:'cancel'}); return; } if(e.metaKey||e.ctrlKey||e.altKey)return; if(editableTarget())return; if(e.key==='i'||e.key==='I'){ e.preventDefault(); post({type:'toggle'}); } else if(PP.panelOpen&&(e.key==='u'||e.key==='U')){ e.preventDefault(); post({type:'screenshot'}); } else if(PP.panelOpen&&(e.key==='e'||e.key==='E')){ e.preventDefault(); post({type:'eye'}); } }
  function setActive(v,keepPending){ if(v&&PP.reviewPermissions&&!PP.reviewPermissions.capture)return; PP.active=v; ensure(); document.documentElement.classList.toggle('pp-picking',v); if(!v){ PP.hi.style.display='none'; PP.tip.style.display='none'; PP.curEl=null; hideCursor(); if(document.body)document.body.style.cursor=''; } else { closePopup(keepPending); discardEdit(); if(document.body)document.body.style.cursor='none'; } }
  document.addEventListener('mousemove',move,true);
  document.addEventListener('click',click,true);
  document.addEventListener('mouseup',selUp,true);
  document.addEventListener('keydown',key,true);
  document.addEventListener('mouseleave',hideCursor,true);
  document.addEventListener('mousedown',function(e){ if(!PP.popup)return; if(e.target&&e.target.closest&&(e.target.closest('.pp-pop')||e.target.closest('.pp-mark')))return; PP.suppressPickClick=true; closePopup(); },true);
  window.addEventListener('scroll',function(){ reposition(); positionHover(); hideCursor(); if(PP.mtip)PP.mtip.style.display='none'; },true);
  window.addEventListener('resize',function(){ reposition(); positionHover(); },true);
  window.addEventListener('message',function(e){ var d=e.data; if(!d||d.__pinpoint!==true)return;
    if(d.cmd==='setPick'){ PP.persist=!!d.active; setActive(!!d.active); }
    else if(d.cmd==='annotations'){ PP.annos=Array.isArray(d.items)?d.items:[]; renderMarkers(); }
    else if(d.cmd==='reveal'){ revealAnno(d.item||{}); }
    else if(d.cmd==='clearReveal'){ clearReveal(); }
    else if(d.cmd==='panel'){ PP.panelOpen=!!d.open; }
    else if(d.cmd==='screenshots'){ PP.screenshots=d.enabled!==false; }
    else if(d.cmd==='preferences'){ PP.reviewPermissions=d.reviewPermissions||null; PP.confirmTextEdits=d.confirmTextEdits===true; PP.showElementOutline=d.showElementOutline===true; if(PP.curEl)positionHover(); else if(!PP.showElementOutline&&PP.hi)PP.hi.style.display='none'; }
  });
  document.addEventListener('mousedown',function(e){ if(!PP.reveal)return; if(e.target&&e.target.closest&&e.target.closest('.pp-reveal'))return; clearReveal(); },true);
  document.addEventListener('click',function(e){
    if(PP.active&&!PP.edit)return;
    var a=e.target&&e.target.closest?e.target.closest('a[href]'):null; if(!a)return;
    var selNow=window.getSelection&&window.getSelection();
    // A click that ends a text selection dragged through a link, any click
    // while a comment popup is open, or any click during an inline text edit
    // (editing a link's text must not navigate), must not navigate — swallow
    // it so the native link nav (and our re-proxy) don't fire and tear down
    // the pick/edit.
    if(PP.popup||PP.edit||(selNow&&!selNow.isCollapsed)){ e.preventDefault(); e.stopPropagation(); return; }
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||a.target==='_blank')return;
    var href=a.href; if(!/^https?:/i.test(href))return;
    var b=document.querySelector('base'); var base=b?b.href:location.href; var cur,u;
    try{ cur=new URL(base); u=new URL(href); }catch(_){return;}
    if(u.origin!==cur.origin)return;
    if(u.pathname===cur.pathname&&u.search===cur.search){ e.preventDefault();
      if(u.hash&&u.hash.length>1){
        // Set the hash on THIS (proxied) document, not the base target, so the
        // browser scrolls natively and CSS :target styles/accordions fire while
        // we stay on the proxy origin.
        if(location.hash===u.hash) location.hash='';
        location.hash=u.hash;
      } else { window.scrollTo(0,0); } return; }
    e.preventDefault(); if(window.__pinpointResourceUrl)location.href=window.__pinpointResourceUrl(u.href);
  },false);
  function postNavigation(){ post({type:'navigate',url:targetLoc().href}); }
  window.addEventListener('bb-pinpoint-navigation',postNavigation);
  window.addEventListener('popstate',postNavigation);
  function announceReady(){setTimeout(function(){post({type:'ready',url:targetLoc().href,protocol:${PICKER_PROTOCOL_VERSION}});},0);}
  if(document.readyState==='complete')announceReady();else window.addEventListener('load',announceReady,{once:true});
})();`;

// ---------------------------------------------------------------------------
  function injectPicker(
    html: string,
    url: string,
    proxyUrl: string,
    foucCapMs = 1500,
  ): string {
    const target = new URL(url);
    // Drop CSP <meta> (header CSP/XFO already gone — fresh Response) and any
    // pre-existing <base> (first base in document order would win over ours).
    html = html.replace(
      /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,
      "",
    );
    html = html.replace(/<base\b[^>]*>/gi, "");
    // Next.js dev hides the body until the client marks the route "ready",
    // which waits on an HMR websocket that can't ride this proxy — strip it so
    // the server-rendered content is visible regardless of hydration.
    html = html.replace(
      /<style[^>]*data-next-hide-fouc[^>]*>[\s\S]*?<\/style>/gi,
      "",
    );
    // Keep same-origin resources inside the anonymous, scoped resource bridge.
    html = rewriteAssets(html, target, proxyUrl);
    // Next dev serves CSS via JS injection, so the raw SSR would flash unstyled
    // before styles apply. Hold the page invisible and fade it in on load (by
    // which point the injected CSS has run), with a hard cap so we never hang
    // blank. This replaces Next's own guard, which waits on an HMR signal that
    // can't ride the proxy. Host-routed previews load far slower, so the caller
    // passes a longer cap for them.
    const foucGate =
      `<style id="pp-fouc">html{opacity:0!important}</style>` +
      `<script>(function(){var done=false;function go(){if(done)return;done=true;var s=document.getElementById('pp-fouc');if(s)s.textContent='html{opacity:1;transition:opacity .14s ease-out}';}if(document.readyState==='complete')go();else window.addEventListener('load',go);setTimeout(go,${foucCapMs});})();</script>`;
    // Absolute capability URL: the app's <base> must not retarget this library.
    const pickerLib = SNAPDOM_SOURCE
      ? `<script src="${escapeAttr(`${proxyUrl}/.pinpoint/picker-lib.js`)}"></script>`
      : "";
    const head =
      foucGate +
      `<base href="${escapeAttr(url)}">` +
      `<script>${proxyShim(url, proxyUrl)}</script>` +
      pickerLib +
      `<script>${PICKER_JS}</script>`;
    if (/<head[^>]*>/i.test(html))
      return html.replace(/<head([^>]*)>/i, (m) => `${m}${head}`);
    if (/<html[^>]*>/i.test(html))
      return html.replace(/<html([^>]*)>/i, (m) => `${m}<head>${head}</head>`);
    return `${head}${html}`;
  }
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultUrl: {
      type: "string",
      label: "Default URL",
      default: "http://localhost:3000",
    },
    relayMode: {
      type: "select",
      label: "Where picks go",
      options: ["thread", "review-chat"],
      default: "review-chat",
    },
    autoDispatch: {
      type: "boolean",
      label: "Send picks to the agent immediately",
      default: true,
    },
  });
  async function integrations() {
    const entries = await Promise.all(
      (["clasi", "agents", "providerUsage"] as const).map(async (key) =>
        [key, await bb.storage.kv.get(`integration:${key}`) === true] as const),
    );
    return integrationSchema.parse(Object.fromEntries(entries));
  }

  const db = bb.storage.database();
  const previews = new PreviewSessions();
  const guestScreenshots = new GuestScreenshotGrants();
  // The statement list lives in lib/store.ts (same statements, same order —
  // APPEND-ONLY) so the store's transition rules are unit-testable against
  // the real schema.
  bb.storage.migrate(db, [...migrations]);

  type DbRow = AnnotationRow;

  const legacyRows = db
    .prepare(`SELECT * FROM annotations WHERE payload IS NULL`)
    .all() as DbRow[];
  const savePayload = db.prepare(`UPDATE annotations SET payload=? WHERE id=?`);
  db.transaction(() => {
    for (const row of legacyRows) {
      savePayload.run(JSON.stringify(annotationFromLegacy(row)), row.id);
    }
  })();
  ensureRoutingRows(db);
  const recoveredDispatches = recoverInterruptedDispatches(db);
  if (recoveredDispatches > 0) {
    bb.log.warn(`re-staged ${recoveredDispatches} interrupted Pinpoint deliveries`);
  }

  const proxyBase = `/api/v1/plugins/${bb.pluginId}/http/proxy`;

  function getRow(id: string): DbRow | null {
    return getAnnotationRow(db, id);
  }

  function routingFor(row: DbRow): AnnotationRouting {
    return storeRoutingFor(db, row.id);
  }

  // `kinds` lets list surfaces pass a batched screenshotKindsForMany lookup;
  // single-row call sites omit it and fall back to the per-row query.
  function toOut(
    row: DbRow,
    kinds?: ScreenshotKind[],
    includeGuestFeedback = true,
  ): z.infer<typeof rowSchema> {
    const reviewState = reviewStateSchema.parse(row.review_state);
    const routing = routingFor(row);
    const annotation = annotationFor(row);
    return {
      schema: "afs",
      schemaVersion: AFS_VERSION,
      annotation,
      projectId: row.project_id,
      threadId: row.thread_id,
      reviewState,
      workflowState: workflowStateFor(reviewState, routing.state),
      routing,
      summary: row.summary,
      screenshots:
        annotation.kind === "text-edit"
          ? []
          : (kinds ?? screenshotKindsFor(db, row.id)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      guestPending: guestPendingFor(row, annotation),
      guestFeedback: includeGuestFeedback ? guestFeedbackFor(row, annotation) : null,
    };
  }

  function heldForOwner(row: DbRow): boolean {
    return annotationFor(row).pinpoint.guestReview?.pendingOwnerDispatch === true;
  }
  function guestPendingFor(row: DbRow, annotation = annotationFor(row)): boolean {
    return (row.review_state === "open" && annotation.pinpoint.guestReview?.pendingOwnerDispatch === true) ||
      annotation.thread.some((message) => message.guest && message.pendingOwnerDispatch);
  }
  function guestFeedbackFor(row: DbRow, annotation = annotationFor(row)): GuestFeedback | null {
    if (!guestPendingFor(row, annotation)) return null;
    const capture = annotation.pinpoint.guestReview?.pendingOwnerDispatch
      ? { comment: annotation.comment, textNew: annotation.kind === "text-edit" ? annotation.textNew ?? null : null } : null;
    const messages = annotation.thread.filter((message) => message.guest && message.pendingOwnerDispatch)
      .map(({ id, content }) => ({ id, content }));
    const revision = createHash("sha256").update(JSON.stringify({ id: row.id, capture, messages })).digest("hex");
    return { revision, capture, messages };
  }
  function annotationForAgent(row: DbRow): AfsAnnotation {
    const annotation = annotationFor(row);
    if (!annotation.pinpoint.guestOriginal &&
        !annotation.thread.some((message) => message.guestOriginalContent !== undefined || (message.guest && message.pendingOwnerDispatch))) return annotation;
    const { guestOriginal: _original, ...context } = annotation.pinpoint;
    const thread: AfsAnnotation["thread"] = [];
    for (const message of annotation.thread) {
      if (message.guest && message.pendingOwnerDispatch) continue;
      if (message.guestOriginalContent === undefined) thread.push(message);
      else {
        const { guestOriginalContent: _originalContent, ...visible } = message;
        thread.push(visible);
      }
    }
    return { ...annotation, pinpoint: annotation.pinpoint.guestOriginal ? context : annotation.pinpoint, thread };
  }
  function toAgentOut(row: DbRow, kinds?: ScreenshotKind[]) {
    return { ...toOut(row, kinds, false), annotation: annotationForAgent(row), guestPending: false };
  }
  function guestScopedRow(scope: GuestReviewScope, id: string): DbRow {
    const target = new URL(scope.url);
    assertPreviewUrl(target, target.origin);
    const row = getRow(id);
    if (!row || row.thread_id !== scope.threadId || !sameCapturePage(row.url, scope.url)) {
      throw new Error("Feedback is outside this review page.");
    }
    return row;
  }
  function canGuestDelete(row: DbRow, actor: GuestActor): boolean {
    const source = annotationFor(row).pinpoint.guestReview;
    return row.review_state === "open" && source?.pendingOwnerDispatch === true &&
      source.reviewRef === actor.reviewRef && source.participantRef === actor.participantRef;
  }
  function toGuestOut(row: DbRow, actor: GuestActor, kinds: ScreenshotKind[]): GuestRow {
    const annotation = annotationFor(row);
    return {
      annotation: publicGuestAnnotationSchema.parse({
        ...annotation,
        pinpoint: { ...annotation.pinpoint, ownerEdited: annotation.pinpoint.guestOriginal !== undefined },
        thread: annotation.thread.map((message) => ({ ...message, ownerEdited: message.guestOriginalContent !== undefined })),
      }),
      workflowState: workflowStateFor(reviewStateSchema.parse(row.review_state), routingFor(row).state),
      summary: row.summary,
      screenshots: annotation.kind === "text-edit" ? [] : kinds,
      createdAt: row.created_at,
      guestPending: guestPendingFor(row, annotation),
      guestCanDelete: canGuestDelete(row, actor),
      authoredByGuest: annotation.pinpoint.guestReview !== undefined,
    };
  }

  // Sync snapshot of threads with live work for contributeInstructions.
  // Two buckets: `agent` is the agent's inbox (review_state open → workflow
  // open/dispatched); `user` is blocked on the user (ready + waiting-input).
  // Only the agent bucket drives the instruction nag, so the agent stops
  // being nagged while every remaining item is waiting on the user.
  const activeByThread = new Map<string, { agent: number; user: number }>();
  const INBOX_BUCKETS = `
       COALESCE(SUM(CASE WHEN review_state='open' THEN 1 ELSE 0 END),0) AS open,
       COALESCE(SUM(CASE WHEN review_state IN ('ready','waiting-input') THEN 1 ELSE 0 END),0) AS blocked,
       COALESCE(SUM(CASE WHEN review_state='open' AND json_valid(payload)
         THEN CASE WHEN json_extract(payload,'$.pinpoint.guestReview.pendingOwnerDispatch')=1 THEN 1 ELSE 0 END
         ELSE 0 END),0) AS held`;
  function cacheActive(threadId: string, row: { open: number; blocked: number; held: number }) {
    const agent = row.open - row.held;
    const user = row.blocked + row.held;
    if (agent > 0 || user > 0) activeByThread.set(threadId, { agent, user });
    else activeByThread.delete(threadId);
  }
  function refreshActive(threadId: string) {
    const row = db.prepare(`SELECT ${INBOX_BUCKETS} FROM annotations WHERE thread_id=?`)
      .get(threadId) as { open: number; blocked: number; held: number };
    cacheActive(threadId, row);
  }
  for (const row of db.prepare(`SELECT thread_id AS t, ${INBOX_BUCKETS} FROM annotations GROUP BY thread_id`)
    .all() as { t: string; open: number; blocked: number; held: number }[]) cacheActive(row.t, row);

  function publishChange(row: DbRow): void {
    refreshActive(row.thread_id);
    bb.realtime.publish("pinpoint", { threadId: row.thread_id });
  }

  // Guarded lifecycle mutations: lib/store.ts enforces the transition table
  // and returns errors on invalid moves; these wrappers add the realtime
  // publish.
  type MutationResult = StoreResult;

  // The ONE structured resolve path (ready | question | reject) shared by the
  // pinpoint_resolve tool and the ready/ask/reject CLI commands. Validation
  // and state changes live in lib/resolve.ts; this wrapper adds the publish.
  function resolveOutcome(
    input: Parameters<typeof applyResolveOutcome>[1],
  ): ReturnType<typeof applyResolveOutcome> {
    const row = getRow(input.id);
    if (row && heldForOwner(row)) return { ok: false, error: "Guest feedback needs owner approval in Guest feedback." };
    const result = applyResolveOutcome(db, input);
    if (result.ok) publishChange(result.row);
    return result;
  }

  function approveAnnotation(id: string): MutationResult {
    const row = getRow(id);
    if (row && guestPendingFor(row)) return { ok: false, error: "Approve the pending guest feedback for processing before completing this item." };
    const result = storeApprove(db, id);
    if (result.ok) publishChange(result.row);
    return result;
  }

  function dismissAnnotation(id: string, reason?: string): MutationResult {
    const result = storeDismiss(db, id, reason);
    if (result.ok) publishChange(result.row);
    return result;
  }

  function reopenAnnotation(
    id: string,
    note?: string,
  ): MutationResult & { staged?: boolean } {
    const result = storeReopen(db, id, note);
    if (result.ok) publishChange(result.row);
    return result;
  }

  // Shared by RPC `remove` and CLI `delete`: routing row + annotation go in
  // one transaction, the change is published, and a thread that was actively
  // working the item (dispatched / waiting-input) gets a best-effort
  // cancellation note so it doesn't keep acting on a deleted id.
  async function deleteAnnotation(
    id: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const result = storeRemove(db, id);
    if (!result.ok) return result;
    publishChange(result.row);
    const workflow = workflowStateFor(
      reviewStateSchema.catch("open").parse(result.row.review_state),
      result.routing?.state ?? "staged",
    );
    const assigned = result.routing?.assignedThreadId;
    if (assigned && (workflow === "dispatched" || workflow === "waiting-input")) {
      try {
        await bb.sdk.threads.send({
          threadId: assigned,
          mode: "auto",
          input: [
            {
              type: "text",
              text: `The Pinpoint feedback item \`${id}\` was deleted by the user. Disregard it — no further action is needed.`,
              mentions: [],
            },
          ],
        });
      } catch (cause) {
        bb.log.warn(`delete cancellation for ${id} failed: ${String(cause)}`);
      }
    }
    return { ok: true };
  }

  // Rows for a project as the frontend/CLI shape, filtered by the UI workflow
  // state. Default (no filter) = the agent's inbox: open + in-progress.
  function listForProject(
    projectId: string,
    workflowState?: WorkflowState,
    includeHeld = false,
  ): z.infer<typeof rowSchema>[] {
    const dbRows = db
      .prepare(
        `SELECT * FROM annotations WHERE project_id=? ORDER BY created_at DESC`,
      )
      .all(projectId) as DbRow[];
    const visible = includeHeld ? dbRows : dbRows.filter((row) => !heldForOwner(row));
    const kinds = screenshotKindsForMany(db, visible.map((r) => r.id));
    const rows = visible.map((r) => includeHeld ? toOut(r, kinds.get(r.id) ?? []) : toAgentOut(r, kinds.get(r.id) ?? []));
    if (workflowState)
      return rows.filter((r) => r.workflowState === workflowState);
    // Default = the agent's inbox. waiting-input and ready are the USER's
    // inbox (blocked on a human), so they are deliberately not listed here.
    return rows.filter((r) => isAgentInboxState(r.workflowState));
  }

  // An agent leaves a comment of its own — a suggestion for the user to review.
  // It lands in review state "ready" (the user's inbox / yellow), authored by
  // the agent, pinned to a selector the same way a user pick is.
  function createAgentComment(input: {
    threadId: string;
    projectId: string;
    url: string;
    comment: string;
    selector?: string;
    pathname?: string;
    nearbyText?: string;
  }): DbRow {
    const now = Date.now();
    const id = `pp_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let annotation = createAfsAnnotation(
      id,
      {
        threadId: input.threadId,
        comment: input.comment,
        url: input.url,
        selector: input.selector ?? undefined,
        pathname: input.pathname ?? undefined,
        nearbyText: input.nearbyText ?? undefined,
      },
      now,
    );
    annotation = afsAnnotationSchema.parse({
      ...annotation,
      status: "acknowledged",
      pinpoint: { ...annotation.pinpoint, authorRole: "agent" },
    });
    annotation = appendThreadMessage(annotation, "agent", input.comment, now);
    db.prepare(
      `INSERT INTO annotations
       (id,project_id,thread_id,status,review_state,comment,url,pathname,title,
        selector,element_path,tag,css_classes,component_name,nearby_text,
        selected_text,rect,x,y,summary,payload,created_at,updated_at)
       VALUES
       (@id,@project_id,@thread_id,'acknowledged','ready',@comment,@url,@pathname,NULL,
        @selector,@element_path,@tag,'',NULL,@nearby_text,
        NULL,NULL,@x,@y,NULL,@payload,@created_at,@updated_at)`,
    ).run({
      id,
      project_id: input.projectId,
      thread_id: input.threadId,
      comment: annotation.comment,
      url: annotation.url ?? input.url,
      pathname: annotation.pinpoint.pathname,
      selector: annotation.pinpoint.selector,
      element_path: annotation.fullPath ?? annotation.elementPath,
      tag: annotation.element,
      nearby_text: annotation.nearbyText ?? null,
      x: annotation.x,
      y: annotation.y,
      payload: JSON.stringify(annotation),
      created_at: now,
      updated_at: now,
    });
    publishChange(getRow(id)!);
    return getRow(id)!;
  }

  async function threadMeta(threadId: string) {
    const thread = (await bb.sdk.threads.get({ threadId })) as unknown as {
      projectId: string;
      environmentId: string | null;
    };
    return { projectId: thread.projectId, environmentId: thread.environmentId };
  }

  // Resolve the thread that should receive relayed feedback.
  async function cachedChild(key: string): Promise<string | null> {
    const childId = await bb.storage.kv.get<string>(key);
    if (!childId) return null;
    try {
      await bb.sdk.threads.get({ threadId: childId });
      return childId;
    } catch {
      await bb.storage.kv.delete(key);
      return null;
    }
  }

  /** Every kv key under which a relay child for `threadId` may be cached. */
  function childKeysFor(threadId: string): string[] {
    return ["pinpoint-review", "text-edit"].flatMap((profile) => [
      `child:${threadId}:profile:${profile}`,
      `child:${threadId}:fallback:${profile}`,
    ]);
  }

  /**
   * Stop routing `threadId`'s relayed feedback to `childThreadId`. Called when
   * a child accepted a pin and then failed to act on it: the thread record is
   * still perfectly valid, so nothing else would ever evict it from the cache.
   */
  async function forgetChild(
    threadId: string,
    childThreadId: string,
  ): Promise<void> {
    for (const key of childKeysFor(threadId)) {
      if ((await bb.storage.kv.get<string>(key)) === childThreadId) {
        await bb.storage.kv.delete(key);
      }
    }
  }

  /** The machine a relay child spawned into this environment would run on. */
  async function hostForEnvironment(
    environmentId: string,
  ): Promise<string | null> {
    try {
      const environment = (await bb.sdk.environments.get({
        environmentId,
      })) as unknown as { hostId?: string | null };
      return environment.hostId ?? null;
    } catch (cause) {
      bb.log.warn(`host lookup for ${environmentId} failed: ${String(cause)}`);
      return null;
    }
  }

  // --- Sandbox-aware preview routing -------------------------------------------
  // A dev server inside a cloud sandbox listens on the sandbox's OWN localhost,
  // unreachable by a server-side fetch. For a loopback target whose thread runs on
  // a remote sandbox host, route the fetch THROUGH that host (see host.ts) so
  // 127.0.0.1:PORT resolves inside the sandbox. Non-loopback targets (external
  // URLs, getbb.app connect links) keep the direct server fetch + cookie path.
  const previewHostClient = bb.hosts.experimental_client({ contract: hostContract });

  function isLoopbackTarget(target: URL): boolean {
    return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/iu.test(
      target.hostname,
    );
  }

  /**
   * Resolve the REMOTE sandbox host a thread runs on, or null when the thread is
   * local / has no environment / lookups fail (so the caller falls back to the
   * direct fetch and nothing regresses for local previews).
   */
  async function remoteSandboxHostForThread(
    threadId: string,
  ): Promise<string | null> {
    try {
      const { environmentId } = await threadMeta(threadId);
      if (!environmentId) return null;
      const hostId = await hostForEnvironment(environmentId);
      if (!hostId) return null;
      const host = (await bb.sdk.hosts.get({ hostId })) as unknown as {
        machineProviderId?: string | null;
      };
      // null = the bb server's own machine. "manual" (legacy sandboxes, other
      // computers) and "sandbox-*" (native sandboxes) are remote.
      return host.machineProviderId ? hostId : null;
    } catch (cause) {
      bb.log.warn(`preview host lookup for ${threadId} failed: ${String(cause)}`);
      return null;
    }
  }

  // Host fetches are one hop. The capability route validates each browser redirect.
  async function fetchPreviewViaHost(
    hostId: string,
    target: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    const fetched = await previewHostClient.call(
      "fetch", { url: target.href, method: "GET", headers, bodyBase64: null, maxResponseBytes: PREVIEW_MAX_BYTES }, { hostId },
    );
    if (fetched.status >= 300 && fetched.status < 400 && fetched.location) {
      if (fetched.continuationToken) {
        await previewHostClient.call("discardResponse", { continuationToken: fetched.continuationToken }, { hostId });
      }
      return new Response(null, { status: fetched.status, headers: { location: fetched.location } });
    }
    const chunks = [Buffer.from(fetched.bodyBase64, "base64")];
    let token = fetched.continuationToken;
    while (token) {
      const chunk = await previewHostClient.call(
        "fetchChunk",
        { continuationToken: token },
        { hostId },
      );
      chunks.push(Buffer.from(chunk.bodyBase64, "base64"));
      token = chunk.continuationToken;
    }
    return new Response(Buffer.concat(chunks), {
      status: fetched.status,
      headers: { "content-type": fetched.contentType },
    });
  }

  /**
   * Would a child spawned on this profile be able to run a turn? Reads the
   * profile's pinned provider/model and the machine's usage snapshot, and
   * refuses the spawn only on a definitive answer — see lib/provider-health.ts
   * for why every unknown resolves to "go ahead".
   */
  async function profileCanRun(
    profile: string,
    hostId: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!hostId) return { ok: true };
    // The role key Pinpoint dispatches by is not the profile's slug; the old
    // slugs stay accepted for installs that have not renamed their agents.
    const slugs = profile === "text-edit"
      ? ["pinpoint-copy", "text-edit-agent"]
      : ["pinpoint-fix", "pinpoint-review"];
    try {
      const profiles = await bb.sdk.plugins.callRpc({
        pluginId: "agent-profiles",
        method: "listProfiles",
        input: null,
        outputSchema: agentProfileListOutputSchema,
      });
      const saved = slugs
        .map((slug) => profiles.find((entry) => entry.slug === slug))
        .find((entry) => entry !== undefined);
      if (!saved) return { ok: true };
      const snapshot = await bb.sdk.plugins.callRpc({
        pluginId: "provider-usage",
        method: "getUsage",
        input: { force: false, machineIds: [hostId], maxAgeMs: 300_000 },
        outputSchema: usageSnapshotOutputSchema,
      });
      return checkProviderHealth({
        providerId: saved.providerId,
        model: saved.model,
        hostId,
        machines: snapshot.machines as UsageMachine[],
      });
    } catch (cause) {
      // No usage data is not evidence of a problem.
      bb.log.info(
        `provider pre-flight for ${slugs[0]} unavailable: ${String(cause)}`,
      );
      return { ok: true };
    }
  }

  async function resolveTarget(
    threadId: string,
    kind?: string | null,
  ): Promise<string> {
    const { relayMode } = await settings.get();
    if (relayMode !== "review-chat") return threadId;
    const textEdit = kind === "text-edit";
    const profile = textEdit ? "text-edit" : "pinpoint-review";
    const title = textEdit ? "Pinpoint text edit" : "Pinpoint review";
    const prompt = textEdit
      ? textEditAgentSpawnPrompt
      : reviewAgentSpawnPrompt;
    const enabled = await integrations();
    const profileKey = `child:${threadId}:profile:${profile}`;
    if (enabled.agents) {
      const existingProfileChild = await cachedChild(profileKey);
      if (existingProfileChild) return existingProfileChild;
    }

    const meta = await threadMeta(threadId);
    if (!meta.environmentId) return threadId;
    // Pre-flight before the spawn, not after: a profile pinned to an exhausted
    // account produces a thread that accepts every pin and acts on none, and
    // nothing downstream can tell that apart from a healthy one. Skipping
    // straight to the fallback child keeps the work off the parent thread.
    const health = enabled.agents && enabled.providerUsage
      ? await profileCanRun(profile, await hostForEnvironment(meta.environmentId))
      : { ok: true as const };
    let profileChild: z.infer<typeof agentProfileSpawnOutputSchema> | null =
      null;
    if (!health.ok) {
      bb.log.warn(
        `${profile} agent skipped; ${health.reason}. Using a default-configuration child instead.`,
      );
    } else if (enabled.agents) {
      try {
        profileChild = await bb.sdk.plugins.callRpc({
          pluginId: "agent-profiles",
          method: "spawnBuiltInProfile",
          input: {
            profile,
            projectId: meta.projectId,
            environment: {
              type: "reuse",
              environmentId: meta.environmentId,
            },
            parentThreadId: threadId,
            title,
            prompt,
          },
          outputSchema: agentProfileSpawnOutputSchema,
        });
      } catch (error) {
        bb.log.warn(
          `${profile} agent unavailable; using the parent agent configuration: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (profileChild) {
      await bb.storage.kv.set(profileKey, profileChild.threadId);
      return profileChild.threadId;
    }

    const fallbackKey = `child:${threadId}:fallback:${profile}`;
    const existingFallback = await cachedChild(fallbackKey);
    if (existingFallback) return existingFallback;
    const child = await bb.sdk.threads.spawn({
      projectId: meta.projectId,
      environment: { type: "reuse", environmentId: meta.environmentId },
      parentThreadId: threadId,
      title,
      visibility: "visible",
      prompt,
    });
    await bb.storage.kv.set(fallbackKey, child.id);
    return child.id;
  }

  // Rendering lives in lib/dispatch-message.ts (unit-tested there); this
  // wrapper just projects the row into its annotation payload.
  function messageFor(
    row: DbRow,
    followUp = false,
    hasScreenshot = false,
  ): string {
    return dispatchMessageFor(annotationForAgent(row), {
      followUp,
      fallbackUrl: row.url,
      hasScreenshot,
    });
  }

  type DispatchOutcome = "sent" | "busy" | "not-staged" | "missing" | "failed";

  const threadStartingRetryDelaysMs = [50, 150, 500, 1_000, 2_000] as const;

  /**
   * An item is only "acknowledged" once an agent has engaged with it. The send
   * itself is not engagement — see lib/delivery-check.ts — so this is called
   * either by the delivery watchdog, once the target has demonstrably done
   * work, or immediately when the target IS the thread the user is talking to
   * and there is no separate agent to verify.
   */
  function markAcknowledged(id: string): void {
    const latest = getRow(id);
    if (!latest || latest.review_state !== "open") return;
    const annotation = annotationFor(latest);
    if (annotation.status === "acknowledged") return;
    storeWriteAnnotation(
      db,
      latest,
      afsAnnotationSchema.parse({ ...annotation, status: "acknowledged" }),
      "open",
      latest.summary,
    );
  }

  // How long to watch a relay child before concluding it is simply busy. A
  // stalled turn ends in seconds; real review work runs for minutes, so the
  // budget only has to outlast the failure mode, not the success one.
  const deliveryWaitSliceMs = 30_000;
  const deliveryWatchBudgetMs = 180_000;
  /**
   * Automatic re-dispatches per item, this process. One is enough to get past
   * a single bad child; beyond that the item stays staged with its lastError
   * showing rather than cycling through spawns nobody asked for.
   */
  const maxDeliveryRecoveries = 1;
  const deliveryRecoveries = new Map<string, number>();

  async function latestEventSeq(threadId: string): Promise<string | null> {
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: "1",
      });
      const seq = rows[0]?.seq;
      return seq === undefined ? null : String(seq);
    } catch {
      return null;
    }
  }

  /**
   * Watch the relay child we just handed `id` to and take the item back if the
   * child accepted it without doing anything. This is the backstop for every
   * way a child can be alive and useless — an exhausted account, a provider
   * that errors on every turn, a runtime that never loads — none of which show
   * up in the thread's status or in the send's result.
   *
   * Runs detached from the dispatch that started it; it must never throw.
   */
  async function watchDelivery(input: {
    id: string;
    parentThreadId: string;
    childThreadId: string;
    afterSeq: string | null;
  }): Promise<void> {
    const { id, childThreadId } = input;
    try {
      let waited = 0;
      let turnEnded = false;
      while (waited < deliveryWatchBudgetMs) {
        const event = await bb.sdk.threads.events.wait({
          threadId: childThreadId,
          type: "turn/completed",
          waitMs: String(deliveryWaitSliceMs),
          ...(input.afterSeq === null ? {} : { afterSeq: input.afterSeq }),
        });
        waited += deliveryWaitSliceMs;
        if (event) {
          turnEnded = true;
          break;
        }
        // The item may have moved on by itself while we waited (the agent
        // resolved it, the user dismissed it, the row was deleted).
        if (!getRow(id)) return;
      }
      // Still going after the budget: that is what working looks like.
      if (!turnEnded) return;
      const events = await bb.sdk.threads.events.list({
        threadId: childThreadId,
        order: "asc",
        limit: "400",
        ...(input.afterSeq === null ? {} : { afterSeq: input.afterSeq }),
      });
      const verdict = classifyDelivery(events as unknown as DeliveryEvent[]);
      if (verdict.kind === "acted") {
        // The counter tracks consecutive failures, so a child that works
        // clears the debt of the one before it.
        deliveryRecoveries.delete(id);
        markAcknowledged(id);
        const row = getRow(id);
        if (row) publishChange(row);
        return;
      }
      // Only reclaim an item that is still sitting with that child: anything
      // else means the state moved on and this verdict is stale.
      const routing = getRouting(db, id);
      if (
        routing?.state !== "assigned" ||
        routing.assignedThreadId !== childThreadId
      ) {
        return;
      }
      const detail = `${childThreadId} accepted this item but ${verdict.detail}`;
      if (!abandonRouting(db, id, detail)) return;
      bb.log.warn(`delivery of ${id} stalled: ${detail}`);
      await forgetChild(input.parentThreadId, childThreadId);
      const reclaimed = getRow(id);
      if (reclaimed) publishChange(reclaimed);
      const attempts = deliveryRecoveries.get(id) ?? 0;
      if (attempts >= maxDeliveryRecoveries) {
        bb.log.warn(
          `leaving ${id} staged after ${attempts} recovery attempt(s); it needs a human`,
        );
        return;
      }
      deliveryRecoveries.set(id, attempts + 1);
      const outcome = await dispatch(id);
      if (outcome !== "sent")
        bb.log.warn(`re-dispatch of stalled ${id} returned ${outcome}`);
    } catch (cause) {
      bb.log.warn(`delivery watch for ${id} failed: ${String(cause)}`);
    }
  }

  function isThreadStartingConflict(cause: unknown): boolean {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return /\b409\b/.test(detail) && /thread is still starting/i.test(detail);
  }

  async function dispatch(id: string, followUp = false): Promise<DispatchOutcome> {
    const row = getRow(id);
    if (!row) return "missing";
    if (heldForOwner(row)) return "not-staged";
    // Follow-ups (replies, feedback) go back to the thread already working
    // this item; a full re-dispatch (conversation embedded by messageFor)
    // only happens when that thread is gone.
    const { target } = await chooseDispatchTarget({
      routing: getRouting(db, id),
      threadExists: async (threadId) => {
        try {
          await bb.sdk.threads.get({ threadId });
          return true;
        } catch {
          return false;
        }
      },
      fallback: async () => {
        try {
          return await resolveTarget(row.thread_id, annotationFor(row).kind);
        } catch (cause) {
          bb.log.warn(`resolveTarget failed: ${String(cause)}`);
          return row.thread_id;
        }
      },
    });

    const claim = claimRouting(db, {
      annotationId: id,
      targetThreadId: target,
    });
    if (claim.outcome !== "claimed") {
      bb.log.warn(`dispatch ${id} not claimed: ${claim.outcome}`);
      if (claim.outcome === "busy") return "busy";
      return claim.outcome === "missing" ? "missing" : "not-staged";
    }
    // Routing can await thread lookup while another reply updates this item.
    // Once the claim is ours, build the message from a fresh snapshot so that
    // reply is included in the send that is about to happen.
    const claimedRow = getRow(id);
    if (!claimedRow) return "missing";
    publishChange(claimedRow);

    const dispatchId = claim.routing.dispatchId!;
    // The prompt names pinpoint_show whenever a screenshot exists — that tool
    // is the GUARANTEED pixel path (R9). The dispatch attachment below is a
    // best-effort extra; any failure falls back to text-only.
    const annotation = annotationForAgent(claimedRow);
    const kinds =
      annotation.kind === "text-edit" ? [] : screenshotKindsFor(db, id);
    // Picker-originated captures advertise the screenshot by default:
    // auto-dispatch races the picker's async upload, so presence alone would
    // make the first dispatch miss it. The prompt says the upload may still
    // be in flight and pinpoint_show degrades to text when nothing is stored.
    // Agent-comment / CLI-created rows keep the presence-based behavior.
    const expectScreenshot =
      annotation.kind !== "text-edit" &&
      (kinds.length > 0 ||
        (annotation.pinpoint.anchored === true &&
          annotation.pinpoint.screenshotExpected !== false));
    const input: (
      | {
          type: "text";
          text: string;
          mentions: never[];
          visibility?: "agent-only";
        }
      | { type: "localImage"; path: string }
    )[] = [
      {
        type: "text",
        text: messageFor(claimedRow, followUp, expectScreenshot),
        mentions: [],
        visibility: "agent-only",
      },
      {
        type: "text",
        text: visibleDispatchMessageFor(annotation),
        mentions: [],
      },
    ];
    if (kinds.length > 0 && claimedRow.project_id) {
      // Spike-gated: bb.sdk.projects.attachments.upload + a localImage input
      // part. Unverified against a live bb — defensive by construction.
      try {
        // Only the one preferred image (element, else viewport) is loaded —
        // the kinds probe above never pulls base64 pixels. Non-null: the kind
        // was just read from the same table.
        const shot = getScreenshot(
          db,
          id,
          kinds.includes("element") ? "element" : kinds[0],
        )!;
        const ext =
          shot.mime === "image/png"
            ? "png"
            : shot.mime === "image/jpeg"
              ? "jpg"
              : "webp";
        const uploaded = await bb.sdk.projects.attachments.upload({
          projectId: claimedRow.project_id,
          clientFile: Uint8Array.from(Buffer.from(shot.data, "base64")),
          filename: `${id}-${shot.kind}.${ext}`,
          mimeType: shot.mime,
        });
        if (uploaded?.type === "localImage" && uploaded.path) {
          input.push({ type: "localImage", path: uploaded.path });
          // Record the attachment ref on the annotation payload (namespaced
          // pinpoint extension; the schema is loose so the key round-trips).
          const latest = getRow(id);
          if (latest)
            patchPinpoint(db, latest, { screenshotAttachment: uploaded.path });
        }
      } catch (cause) {
        bb.log.warn(
          `screenshot attachment for ${id} failed (sending text-only): ${String(cause)}`,
        );
      }
    }
    // Relayed to a separate agent rather than to the thread the user is in:
    // the send alone proves nothing about whether that agent acts, so note
    // where its event log stands and verify afterwards.
    const relayed = target !== claimedRow.thread_id;
    const beforeSeq = relayed ? await latestEventSeq(target) : null;
    try {
      let retryIndex = 0;
      while (true) {
        try {
          await bb.sdk.threads.send({
            threadId: target,
            mode: "auto",
            input,
          });
          break;
        } catch (cause) {
          const delay = threadStartingRetryDelaysMs[retryIndex];
          if (delay === undefined || !isThreadStartingConflict(cause)) throw cause;
          retryIndex += 1;
          bb.log.info(
            `dispatch ${id} waiting ${delay}ms for thread ${target} to finish starting`,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          const liveRow = getRow(id);
          const liveRouting = getRouting(db, id);
          if (
            !liveRow ||
            liveRouting?.state !== "sending" ||
            liveRouting.dispatchId !== dispatchId
          ) {
            bb.log.info(`dispatch ${id} canceled before startup retry`);
            return liveRow ? "failed" : "missing";
          }
        }
      }
      const completed = db.transaction(() => {
        if (!completeRouting(db, id, dispatchId)) return false;
        // Delivered, but "acknowledged" is a claim about the AGENT, and a
        // relay child has not made one yet. watchDelivery decides.
        if (!relayed) markAcknowledged(id);
        return true;
      })();
      if (!completed) {
        bb.log.warn(`dispatch ${id} completed after its claim changed`);
        return "failed";
      }
      // The row can be deleted while the send was in flight — skip publish
      // and follow-up state silently (the deletion path already sent the
      // cancellation note to the thread).
      const sent = getRow(id);
      if (!sent) return "sent";
      publishChange(sent);
      // Detached on purpose: the pin is delivered, and the caller must not
      // block for minutes waiting to find out whether it landed.
      if (relayed) {
        void watchDelivery({
          id,
          parentThreadId: sent.thread_id,
          childThreadId: target,
          afterSeq: beforeSeq,
        });
      }
      // A reply saved while this send was in flight (reopen hit the
      // sending-claim busy path) is re-staged and dispatched exactly once.
      // The flag is cleared BEFORE dispatching so this can never loop.
      if (annotationFor(sent).pinpoint.pendingFollowUp === true) {
        patchPinpoint(db, sent, { pendingFollowUp: undefined });
        stageRouting(db, id);
        const followUpOutcome = await dispatch(id, true);
        if (followUpOutcome !== "sent")
          bb.log.warn(
            `pending follow-up for ${id} not delivered: ${followUpOutcome}`,
          );
      }
      return "sent";
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      failRouting(db, id, dispatchId, detail);
      bb.log.warn(`dispatch send failed: ${detail}`);
      // Same deletion race as above: a missing row means the annotation was
      // removed mid-send — nothing left to publish or update.
      const failed = getRow(id);
      if (failed) publishChange(failed);
      return "failed";
    }
  }

  // Pinpoint owns consent. Clasi receives only the approved preference and audit metadata.
  const learningDeps: LearningWriteDeps = {
    isEnabled: async () => (await integrations()).clasi,
    callRpc: (args) => bb.sdk.plugins.callRpc(args),
    getProject: async (projectId: string) => {
      const project = await bb.sdk.projects.get({ projectId });
      return { id: project.id, gitRemoteUrl: project.gitRemoteUrl };
    },
  };

  // Consent + write for one approved row (approve opt-in and retry share it).
  // The write outcome NEVER fails the caller — it lands on the payload as
  // learningWrite saved/failed and the card renders it; a failure comes back
  // as a warning string.
  async function attemptLearningWrite(id: string): Promise<string | undefined> {
    const write = await performLearningWrite(db, id, learningDeps);
    if (write.row) publishChange(write.row);
    if (!write.ok)
      return `Saving the learning to Clasi failed: ${write.error}. You can retry from the card.`;
    return undefined;
  }
  let liveTargetTransition: Promise<void> = Promise.resolve();
  function serializeLiveTarget<T>(operation: () => Promise<T>): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    liveTargetTransition = liveTargetTransition
      .catch(() => undefined)
      .then(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      });
    return promise;
  }
  async function readLiveTarget(threadId: string): Promise<{
    expiresAt: number;
    registrationId: string;
    url: string;
    shareId?: string;
    revision?: number;
  } | null> {
    const key = `live-target:${threadId}`;
    const value = await bb.storage.kv.get<unknown>(key);
    if (
      !value ||
      typeof value !== "object" ||
      !("expiresAt" in value) ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= Date.now() ||
      !("registrationId" in value) ||
      typeof value.registrationId !== "string" ||
      !("url" in value) ||
      typeof value.url !== "string"
    ) {
      if (value !== undefined) await bb.storage.kv.delete(key);
      return null;
    }
    return {
      expiresAt: value.expiresAt,
      registrationId: value.registrationId,
      url: value.url,
      ...("shareId" in value && typeof value.shareId === "string"
        ? { shareId: value.shareId }
        : {}),
      ...("revision" in value &&
      typeof value.revision === "number" &&
      Number.isInteger(value.revision) &&
      value.revision >= 0
        ? { revision: value.revision }
        : {}),
    };
  }

  async function createCapture(input: CaptureInput, guestActor?: GuestActor) {
    const now = Date.now();
    // The stamp is adopted only when unused; collisions never overwrite a row.
    const clientId = typeof input.clientId === "string" &&
      /^pp_[a-z0-9]{4,24}$/.test(input.clientId) && !getRow(input.clientId) ? input.clientId : null;
    const id = clientId ?? `pp_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let projectId = "";
    try { projectId = (await threadMeta(input.threadId)).projectId; }
    catch (cause) { if (guestActor) throw cause; }
    if (guestActor && !projectId) throw new Error("The review thread is unavailable.");
    const normalizedInput = input.kind === "text-edit" ? { ...input, screenshotExpected: false } : input;
    const annotation = createAfsAnnotation(id, normalizedInput, now);
    if (guestActor) annotation.pinpoint.guestReview = { ...guestActor, pendingOwnerDispatch: true };
    db.transaction(() => {
      db.prepare(
        `INSERT INTO annotations
         (id,project_id,thread_id,status,review_state,comment,url,pathname,title,
          selector,element_path,tag,css_classes,component_name,nearby_text,
          selected_text,rect,x,y,summary,payload,created_at,updated_at)
         VALUES
         (@id,@project_id,@thread_id,'pending','open',@comment,@url,@pathname,@title,
          @selector,@element_path,@tag,@css_classes,@component_name,@nearby_text,
          @selected_text,@rect,@x,@y,NULL,@payload,@created_at,@updated_at)`,
      ).run({
        id, project_id: projectId, thread_id: input.threadId,
        comment: annotation.comment, url: annotation.url ?? input.url,
        pathname: annotation.pinpoint.pathname, title: annotation.pinpoint.title,
        selector: annotation.pinpoint.selector, element_path: annotation.fullPath ?? annotation.elementPath,
        tag: annotation.element, css_classes: annotation.cssClasses ?? "",
        component_name: annotation.reactComponents ?? null, nearby_text: annotation.nearbyText ?? null,
        selected_text: annotation.selectedText ?? null,
        rect: annotation.boundingBox ? JSON.stringify(annotation.boundingBox) : null,
        x: annotation.x, y: annotation.y, payload: JSON.stringify(annotation),
        created_at: now, updated_at: now,
      });
      stageRouting(db, id, now);
    })();
    const created = getRow(id)!;
    publishChange(created);
    const createdOut = toOut(created);
    // A guest may store feedback, never choose a provider, spawn, send or learn.
    if (guestActor) return { row: createdOut, dispatched: false, captureId: id };
    const { autoDispatch } = await settings.get();
    let dispatched = false;
    try { dispatched = autoDispatch ? (await dispatch(id)) === "sent" : false; }
    catch (error) { bb.log.error(`capture dispatch failed for ${id}: ${String(error)}`); }
    const latest = getRow(id);
    return { row: latest ? toOut(latest) : createdOut, dispatched, captureId: id };
  }
  async function prepareGuestResource(input: z.infer<typeof rpcContract.prepareGuestProxy.input>) {
    const target = new URL(input.targetUrl);
    const base = new URL(input.proxyBase);
    const protectedOrigins = new Set([base.origin, new URL(bb.server.loopbackBaseUrl).origin]);
    if (bb.server.experimental_appUrl) protectedOrigins.add(new URL(bb.server.experimental_appUrl).origin);
    assertPreviewUrl(target, target.origin);
    assertPreviewUrl(base, base.origin);
    if (protectedOrigins.has(target.origin) || base.search || base.hash || /[;'"\s]/.test(base.href) ||
        !/\/[a-z0-9_-]{32,}$/i.test(base.pathname)) {
      throw new Error("Guest previews require a separate origin and a scoped capability URL.");
    }
    const policy = { origin: target.origin, resourceOrigins: new Set<string>() };
    const source = Buffer.from(input.bodyBase64, "base64");
    let body: string | Uint8Array = source;
    if (input.contentType.includes("text/html")) {
      const html = source.toString("utf8");
      collectResourceOrigins(html, policy, protectedOrigins);
      body = injectPicker(await rewritePreviewHtmlModules(html, target, base.href), target.href, base.href);
    } else if (input.contentType.includes("text/css")) body = rewriteCss(source.toString("utf8"), target, base.href);
    else if (/javascript|ecmascript/.test(input.contentType)) body = await rewritePreviewModules(source.toString("utf8"), target, base.href);
    return {
      isolationVersion: GUEST_PREVIEW_ISOLATION_VERSION,
      headers: previewHeaders(policy, base.href), contentType: input.contentType,
      bodyBase64: Buffer.from(body).toString("base64"),
    } as const;
  }

  // -------------------------------------------------------------------------
  // RPC (frontend data plane)
  // -------------------------------------------------------------------------
  bb.rpc.register(rpcContract, {
    async approveGuestFeedback(input) {
      const approved = db.transaction(() => {
        const row = getRow(input.id);
        if (!row) throw new Error("Feedback is no longer available.");
        const annotation = annotationFor(row);
        const pending = guestFeedbackFor(row, annotation);
        if (!pending || pending.revision !== input.revision) throw new Error("Guest feedback changed. Review the latest comments before approving.");
        if (Boolean(input.capture) !== Boolean(pending.capture) ||
            input.messages.length !== pending.messages.length ||
            input.messages.some((message, index) => message.id !== pending.messages[index]!.id)) {
          throw new Error("Approval must include the exact pending guest feedback.");
        }
        if (input.capture && annotation.kind !== "text-edit" && (!input.capture.comment.trim() || input.capture.textNew !== null)) {
          throw new Error("Guest feedback needs a comment, not a text edit.");
        }
        if (input.capture && annotation.kind === "text-edit" && input.capture.textNew === null) throw new Error("A text edit needs its proposed text.");
        const captureChanged = input.capture && pending.capture &&
          (input.capture.comment !== pending.capture.comment || input.capture.textNew !== pending.capture.textNew);
        let index = 0;
        const edited: AfsAnnotation = {
          ...annotation,
          ...(input.capture ? { comment: input.capture.comment, ...(annotation.kind === "text-edit" ? { textNew: input.capture.textNew! } : {}) } : {}),
          pinpoint: {
            ...annotation.pinpoint,
            ...(input.capture && annotation.pinpoint.guestReview ? {
              guestReview: { ...annotation.pinpoint.guestReview, pendingOwnerDispatch: false },
            } : {}),
            ...(captureChanged ? { guestOriginal: annotation.pinpoint.guestOriginal ?? pending.capture! } : {}),
          },
          thread: annotation.thread.map((message) => {
            if (!message.guest || !message.pendingOwnerDispatch) return message;
            const content = input.messages[index++]!.content;
            return {
              ...message, content, pendingOwnerDispatch: false,
              ...(content !== message.content ? { guestOriginalContent: message.guestOriginalContent ?? message.content } : {}),
            };
          }),
        };
        storeWriteAnnotation(db, row, edited, reviewStateSchema.parse(row.review_state), row.summary);
        const reopened = storeReopen(db, row.id);
        if (!reopened.ok) throw new Error(reopened.error);
        return reopened.row;
      })();
      publishChange(approved);
      const outcome = await dispatch(input.id, true);
      const latest = getRow(input.id);
      if (!latest) throw new Error("Feedback was deleted during approval.");
      const warning = outcome === "failed" ? "Feedback approved, but the agent could not be reached. Retry from this card." :
        outcome === "busy" ? "Feedback approved. A delivery is already in progress." : undefined;
      return { row: toOut(latest), ...(warning ? { warning } : {}) };
    },
    async captureGuest(input) {
      const target = new URL(input.url);
      assertPreviewUrl(target, target.origin);
      const actor = { reviewRef: input.reviewRef, participantRef: input.participantRef };
      const captured = await createCapture(input, actor);
      const screenshotUpload = input.kind !== "text-edit" && input.screenshotExpected !== false
        ? guestScreenshots.create({
          ...actor, annotationId: captured.captureId, threadId: input.threadId, url: input.url,
        }) : null;
      return {
        captureId: captured.captureId,
        screenshotUpload: screenshotUpload ? { token: screenshotUpload.token, expiresAt: screenshotUpload.expiresAt } : null,
      };
    },
    listGuest(input) {
      const target = new URL(input.url);
      assertPreviewUrl(target, target.origin);
      const rows = (db.prepare(`SELECT * FROM annotations WHERE thread_id=? ORDER BY created_at DESC`)
        .all(input.threadId) as DbRow[]).filter((row) => sameCapturePage(row.url, input.url));
      const kinds = screenshotKindsForMany(db, rows.map((row) => row.id));
      return { rows: rows.map((row) => toGuestOut(row, input, kinds.get(row.id) ?? [])) };
    },
    replyGuest(input) {
      const updated = db.transaction(() => {
        const row = guestScopedRow(input, input.id);
        const annotation = appendThreadMessage(annotationFor(row), "human", input.text, Date.now(), true);
        return storeWriteAnnotation(db, row, annotation, reviewStateSchema.parse(row.review_state), row.summary);
      })();
      publishChange(updated);
      return { ok: true as const };
    },
    deleteGuest(input) {
      const result = db.transaction(() => {
        const row = guestScopedRow(input, input.id);
        if (!canGuestDelete(row, input)) throw new Error("Only your own feedback awaiting owner review can be deleted.");
        return storeRemove(db, row.id);
      })();
      if (!result.ok) throw new Error(result.error);
      guestScreenshots.revoke(input.id);
      publishChange(result.row);
      return { ok: true as const };
    },
    screenshotGuest(input) {
      const row = guestScopedRow(input, input.id);
      return { shot: annotationFor(row).kind === "text-edit" ? null : getScreenshot(db, row.id, input.kind) };
    },
    uploadGuestScreenshot(input) {
      const grant = guestScreenshots.get(input.token);
      if (!grant) throw new Error("Screenshot capture expired.");
      const row = getRow(grant.annotationId);
      const source = row ? annotationFor(row).pinpoint.guestReview : null;
      if (!row || row.thread_id !== grant.threadId || !sameCapturePage(row.url, grant.url) ||
          source?.reviewRef !== grant.reviewRef || source?.participantRef !== grant.participantRef) {
        throw new Error("Screenshot capture is no longer available.");
      }
      const stored = storeScreenshot(db, {
        annotationId: row.id, kind: input.kind, mime: input.mime, data: input.screenshot, pageUrl: grant.url,
      });
      if (!stored.ok) throw new Error(stored.error);
      publishChange(row);
      return { ok: true as const };
    },
    prepareGuestPickerLibrary(input) {
      if (!SNAPDOM_SOURCE) throw new Error("The installed screenshot library is unavailable.");
      return prepareGuestResource({
        ...input, contentType: "text/javascript; charset=utf-8",
        bodyBase64: Buffer.from(SNAPDOM_SOURCE).toString("base64"),
      });
    },
    uploadScreenshot(input) {
      const row = getRow(input.clientId);
      if (!row || row.thread_id !== input.threadId) throw new Error("Screenshot does not belong to this thread.");
      const stored = storeScreenshot(db, {
        annotationId: input.clientId, kind: input.kind, mime: input.mime,
        data: input.screenshot, pageUrl: input.url,
      });
      if (!stored.ok) throw new Error(stored.error);
      publishChange(row);
      return { ok: true as const };
    },
    integrations,
    async setIntegration({ integration, enabled }) {
      await bb.storage.kv.set(`integration:${integration}`, enabled);
      const next = await integrations();
      bb.realtime.publish("pinpoint", { integrationsChanged: true });
      return next;
    },
    async config() {
      const s = await settings.get();
      return {
        defaultUrl: s.defaultUrl,
        relayMode: s.relayMode as "thread" | "review-chat",
        autoDispatch: s.autoDispatch,
        clasiLearning: (await integrations()).clasi,
        proxyBase,
      };
    },
    liveTarget({ threadId }) {
      return serializeLiveTarget(async () => ({
        url: (await readLiveTarget(threadId))?.url ?? null,
      }));
    },
    setLiveTarget({
      threadId,
      url,
      registrationId,
      observedShareId,
      observedRevision,
    }) {
      return serializeLiveTarget(async () => {
        const target = new URL(url);
        if (target.protocol !== "http:" && target.protocol !== "https:") {
          throw new Error("Pinpoint live target must use HTTP or HTTPS.");
        }
        previews.renew(threadId, target.origin);
        const current = await readLiveTarget(threadId);
        if (
          current?.shareId !== undefined &&
          current.revision !== undefined &&
          (observedShareId !== current.shareId ||
            observedRevision !== current.revision)
        ) {
          return { ok: true as const };
        }
        await bb.storage.kv.set(`live-target:${threadId}`, {
          expiresAt: Date.now() + LIVE_TARGET_TTL_MS,
          registrationId,
          url: target.href,
          ...(current?.registrationId === registrationId &&
          current.shareId !== undefined &&
          current.revision !== undefined
            ? { shareId: current.shareId, revision: current.revision }
            : {}),
        });
        return { ok: true as const };
      });
    },
    clearLiveTarget({ threadId, registrationId }) {
      return serializeLiveTarget(async () => {
        const key = `live-target:${threadId}`;
        const value = await bb.storage.kv.get<{ registrationId?: unknown }>(key);
        if (
          value &&
          typeof value === "object" &&
          value.registrationId === registrationId
        ) {
          await bb.storage.kv.delete(key);
        }
        return { ok: true as const };
      });
    },
    navigateLiveTarget({ threadId, url, shareId, revision }) {
      return serializeLiveTarget(async () => {
        const key = `live-target:${threadId}`;
        const value = await readLiveTarget(threadId);
        if (!value) return { ok: false };
        const current = new URL(value.url);
        const target = new URL(url);
        if (target.origin !== current.origin) {
          throw new Error("Guest navigation left the approved origin.");
        }
        if (
          value.shareId === shareId &&
          value.revision !== undefined &&
          revision <= value.revision
        ) {
          return { ok: true };
        }
        await bb.storage.kv.set(key, {
          ...value,
          expiresAt: Date.now() + LIVE_TARGET_TTL_MS,
          url: target.href,
          shareId,
          revision,
        });
        bb.realtime.publish("pinpoint", {
          threadId,
          navigation: { url: target.href, shareId, revision },
        });
        return { ok: true };
      });
    },
    prepareGuestProxy: prepareGuestResource,
    publicReviewController() {
      return { script: PUBLIC_REVIEW_CLIENT_JS };
    },
    publicReviewStyles() {
      return { css: loadPublicReviewStyles() };
    },
    capture(input) { return createCapture(input); },
    list(input) {
      const dbRows = db
        .prepare(
          `SELECT * FROM annotations WHERE thread_id=? ORDER BY created_at DESC`,
        )
        .all(input.threadId) as DbRow[];
      const kinds = screenshotKindsForMany(db, dbRows.map((r) => r.id));
      const rows = dbRows
        .map((r) => toOut(r, kinds.get(r.id) ?? []))
        .filter((row) => !input.status || row.workflowState === input.status);
      return { rows };
    },
    async update(input) {
      if (!getRow(input.id)) throw new Error(`no such annotation: ${input.id}`);
      let warning: string | undefined;
      switch (input.action) {
        case "approve": {
          const result = approveAnnotation(input.id);
          if (!result.ok) throw new Error(result.error);
          // Consent loop (R12): ONLY an explicit `learning: true` opt-in
          // records consent and writes to clasi. Approve-without-opt-in,
          // dismiss, and silence all write NOTHING (AE4) — the proposal just
          // stays on the card as not saved. The approve itself has already
          // succeeded; consent/write outcomes only surface as warnings.
          if (input.learning === true) {
            const consent = (await integrations()).clasi
              ? recordLearningConsent(db, input.id, input.approvedLearning)
              : { ok: false as const, error: "Enable Clasi learning in Settings → Pinpoint → Oh My BB." };
            if (!consent.ok) {
              warning = `Approved, but the learning could not be saved: ${consent.error}`;
            } else {
              publishChange(consent.row);
              warning = await attemptLearningWrite(input.id);
            }
          }
          break;
        }
        case "retry-learning": {
          warning = await attemptLearningWrite(input.id);
          break;
        }
        case "dismiss": {
          const result = dismissAnnotation(input.id, input.note);
          if (!result.ok) throw new Error(result.error);
          break;
        }
        case "feedback":
        case "redispatch": {
          const current = getRow(input.id);
          if (current && guestPendingFor(current)) throw new Error("Review the pending Guest feedback before sending more work.");
          const reopened = reopenAnnotation(input.id, input.note);
          if (!reopened.ok) throw new Error(reopened.error);
          const outcome = await dispatch(input.id, input.action === "feedback");
          // A busy claim means a send to the agent is already in flight; the
          // note is saved on the item (reopen appended it to the conversation)
          // and rides the next dispatch — tell the user instead of silently
          // dropping it.
          if (outcome === "busy")
            warning =
              "A message to the agent is still being delivered. Your note is saved on this item and will be included the next time it is sent.";
          else if (outcome === "failed")
            warning =
              "Delivering to the agent failed. Your note is saved on this item. Retry the send from its card.";
          break;
        }
      }
      // The row can vanish while an awaited dispatch/write was in flight
      // (deletion races the send) — report it instead of crashing.
      const latest = getRow(input.id);
      if (!latest)
        throw new Error(`no such annotation: ${input.id} (deleted during update)`);
      // Omit `warning` entirely when absent: the host's strict JSON result
      // boundary rejects explicit `undefined` values.
      return {
        row: toOut(latest),
        ...(warning !== undefined ? { warning } : {}),
      };
    },
    async probe(input) {
      try {
        const res = await fetch(input.url, {
          method: "GET",
          signal: AbortSignal.timeout(5000),
        });
        return { ok: res.ok, status: res.status };
      } catch {
        return { ok: false, status: null };
      }
    },
    async remove(input) {
      const result = await deleteAnnotation(input.id);
      return { ok: result.ok };
    },
    screenshot(input) {
      const row = getRow(input.id);
      if (row && annotationFor(row).kind === "text-edit") {
        return { shot: null };
      }
      const shot = getScreenshot(db, input.id, input.kind);
      return { shot: shot ? { mime: shot.mime, data: shot.data } : null };
    },
  });

  // -------------------------------------------------------------------------
  // Proxy + injected picker
  // -------------------------------------------------------------------------
  // Only the authenticated BB owner can issue a preview capability.
  bb.http.route("GET", "/proxy", async (c) => {
    if (c.req.header("origin") === "null" ||
        ["cross-site", "same-site"].includes(c.req.header("sec-fetch-site") ?? "")) {
      return c.text("Open previews from the Pinpoint address bar.", 403);
    }
    const raw = c.req.query("u");
    const threadId = c.req.query("t");
    if (!raw || !threadId) return c.text("A preview URL and thread are required.", 400);
    try {
      const target = new URL(/^https?:\/\//i.test(raw) ? raw : `${/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(raw) ? "http" : "https"}://${raw}`);
      assertPreviewUrl(target, target.origin);
      await threadMeta(threadId);
      const requestUrl = new URL(c.req.url);
      const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? requestUrl.host).split(",")[0]!.trim();
      const protocol = (c.req.header("x-forwarded-proto") ?? requestUrl.protocol.replace(":", "")).split(",")[0]!.trim();
      const viewerOrigin = new URL(`${protocol}://${host}`).origin;
      assertPreviewUrl(new URL(viewerOrigin), viewerOrigin);
      const origin = c.req.header("origin");
      if (origin && origin !== viewerOrigin) return c.text("Open previews from the Pinpoint address bar.", 403);
      const protectedOrigins = new Set([viewerOrigin, requestUrl.origin, new URL(bb.server.loopbackBaseUrl).origin]);
      if (bb.server.experimental_appUrl) protectedOrigins.add(new URL(bb.server.experimental_appUrl).origin);
      const hostId = isLoopbackTarget(target) ? await remoteSandboxHostForThread(threadId) : null;
      const bbPort = new URL(bb.server.loopbackBaseUrl).port;
      if (protectedOrigins.has(target.origin) || (bbPort && target.port === bbPort)) {
        return c.text("BB itself cannot be loaded as a preview.", 403);
      }
      const session = previews.create({
        threadId, origin: target.origin, viewerOrigin, hostId,
      });
      const base = `${viewerOrigin}${proxyBase.replace(/\/proxy$/, "/preview")}/${session.token}`;
      return new Response(null, {
        status: 303,
        headers: { location: previewResourceUrl(base, target), "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    } catch (cause) {
      return c.text(cause instanceof Error ? cause.message : "Invalid preview URL.", 400);
    }
  }, { auth: "local" });

  // The bearer reads only one selected origin. It cannot call BB RPC, write
  // feedback, forward browser credentials, or follow an off-origin redirect.
  bb.http.route("GET", "/preview/:token/*", async (c) => {
    const token = c.req.param("token") ?? "";
    const session = previews.get(token);
    if (!session) return c.text("Preview expired. Reload it from Pinpoint.", 410);
    const requestUrl = new URL(c.req.url);
    const marker = `/preview/${token}`;
    const path = requestUrl.pathname.slice(requestUrl.pathname.indexOf(marker) + marker.length);
    const target = new URL(`${session.origin}${path}${requestUrl.search}`);
    const base = `${session.viewerOrigin}${proxyBase.replace(/\/proxy$/, "/preview")}/${token}`;
    const headers = previewHeaders(session, base);
    try {
      assertPreviewUrl(target, session.origin);
      if (path === "/.pinpoint/picker-lib.js") {
        return new Response(SNAPDOM_SOURCE || "// Screenshot library unavailable", {
          status: SNAPDOM_SOURCE ? 200 : 404, headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
        });
      }
      const upstreamHeaders: Record<string, string> = { "user-agent": "bb-pinpoint-preview" };
      const upstream = session.hostId
        ? await fetchPreviewViaHost(session.hostId, target, upstreamHeaders)
        : await fetch(target.href, { redirect: "manual", headers: upstreamHeaders, signal: AbortSignal.timeout(15_000) });
      const location = upstream.headers.get("location");
      if (upstream.status >= 300 && upstream.status < 400 && location) {
        await upstream.body?.cancel();
        const destination = new URL(location, target);
        assertPreviewUrl(destination, session.origin);
        return new Response(null, { status: upstream.status, headers: { ...headers, location: previewResourceUrl(base, destination) } });
      }
      const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
      const bytes = await readPreviewBody(upstream);
      let body: string | Uint8Array<ArrayBuffer> = bytes;
      if (contentType.includes("text/html")) {
        const html = new TextDecoder().decode(bytes);
        const protectedOrigins = new Set([session.viewerOrigin, new URL(bb.server.loopbackBaseUrl).origin]);
        if (bb.server.experimental_appUrl) protectedOrigins.add(new URL(bb.server.experimental_appUrl).origin);
        collectResourceOrigins(html, session, protectedOrigins);
        body = injectPicker(await rewritePreviewHtmlModules(html, target, base), target.href, base, session.hostId ? 15_000 : 1500);
      } else if (contentType.includes("text/css")) {
        body = rewriteCss(new TextDecoder().decode(bytes), target, base);
      } else if (/javascript|ecmascript/.test(contentType)) {
        body = await rewritePreviewModules(new TextDecoder().decode(bytes), target, base);
      }
      return new Response(upstream.status === 204 || upstream.status === 304 ? null : body, {
        status: upstream.status,
        headers: { ...previewHeaders(session, base), "content-type": contentType },
      });
    } catch (cause) {
      return new Response(cause instanceof Error ? cause.message : "Preview fetch failed.", {
        status: 502, headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
      });
    }
  }, { auth: "none" });





  // -------------------------------------------------------------------------
  // Native agent tools (bb-native harness-agnostic path)
  // -------------------------------------------------------------------------
  bb.agents.registerTool({
    name: TOOL_LIST,
    description:
      "List Pinpoint visual feedback the user pinned on the running app for this project. Returns open and in-progress items with their DOM selector, component, page URL and comment so you can locate the code.",
    instructions: listToolInstruction,
    presentation: {
      label: {
        pending: "Loading Pinpoint feedback",
        completed: "Loaded Pinpoint feedback",
      },
      icon: { glyph: "ListView" },
    },
    parameters: z.object({
      status: workflowStateSchema.optional(),
    }),
    async execute({ status }, ctx) {
      const projectId = await projectFor(ctx);
      if (!projectId) return "No project context; cannot list Pinpoint items.";
      const rows = listForProject(projectId, status);
      if (!rows.length) return "No matching Pinpoint feedback.";
      return JSON.stringify(rows, null, 2);
    },
  });

  bb.agents.registerTool({
    name: TOOL_RESOLVE,
    description: resolveToolDescription,
    presentation: {
      label: {
        pending: "Updating Pinpoint feedback",
        completed: "Updated Pinpoint feedback",
      },
      icon: { glyph: "Target" },
    },
    parameters: z.object({
      id: z.string(),
      // Default "ready" keeps older prompts ({id, summary}) working.
      outcome: z.enum(resolveOutcomes).default("ready"),
      summary: z.string().optional(),
      question: z.string().optional(),
      scope: z
        .object({
          breadth: z.enum(scopeBreadths),
          target: z.enum(scopeTargets),
        })
        .optional(),
      receipt: z.string().optional(),
      // ONE proposed generalized design/copy learning (R12); validated in the
      // shared handler, dropped (with the reason returned) when invalid.
      proposedLearning: z
        .object({
          topic: z.enum(learningTopics),
          logicalKey: z.string(),
          text: z.string(),
        })
        .optional(),
    }),
    async execute(
      { id, outcome, summary, question, scope, receipt, proposedLearning },
      ctx,
    ) {
      const r = getRow(id);
      if (!r)
        return {
          isError: true,
          content: [{ type: "text", text: `No such Pinpoint item: ${id}` }],
        };
      // Cross-project ids are rejected: an agent may only resolve feedback
      // that belongs to the project it is running in.
      const projectId = await projectFor(ctx);
      if (!projectId || (r.project_id && r.project_id !== projectId))
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Pinpoint item ${id} does not belong to this project.`,
            },
          ],
        };
      const result = resolveOutcome({
        id,
        outcome,
        summary,
        question,
        scope,
        receipt,
        proposedLearning,
      });
      if (!result.ok)
        return {
          isError: true,
          content: [{ type: "text", text: result.error }],
        };
      // AE3: a rejected proposal never blocks the resolution — the item is
      // ready; the agent just learns why its proposal was dropped.
      if (result.learningRejected)
        return `${result.message} Your proposed learning was NOT kept: ${result.learningRejected}`;
      return result.message;
    },
  });

  // The guaranteed screenshot-pixels path (R9): full annotation context as
  // text plus an image content part per stored screenshot. Project-scoped
  // like pinpoint_resolve.
  bb.agents.registerTool({
    name: TOOL_SHOW,
    description:
      "Show one Pinpoint feedback item in full, including the captured screenshots (pinned element crop + surrounding viewport) as viewable images when they exist.",
    presentation: {
      label: {
        pending: "Loading Pinpoint feedback details",
        completed: "Loaded Pinpoint feedback details",
      },
      icon: { glyph: "Eye" },
    },
    parameters: z.object({ id: z.string() }),
    async execute({ id }, ctx) {
      const r = getRow(id);
      if (!r)
        return {
          isError: true,
          content: [{ type: "text", text: `No such Pinpoint item: ${id}` }],
        };
      if (heldForOwner(r)) return {
        isError: true,
        content: [{ type: "text", text: "Guest feedback needs owner approval in Guest feedback." }],
      };
      const projectId = await projectFor(ctx);
      if (!projectId || (r.project_id && r.project_id !== projectId))
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Pinpoint item ${id} does not belong to this project.`,
            },
          ],
        };
      const annotation = annotationFor(r);
      return buildShowResult(
        JSON.stringify(toAgentOut(r), null, 2),
        annotation.kind === "text-edit" ? [] : screenshotsFor(db, id),
      );
    },
  });

  // Short, live instruction only for threads with work the AGENT can act on.
  // Items that are ready or waiting-input are the user's inbox — while
  // everything is blocked on the user, the agent isn't nagged.
  bb.agents.contributeInstructions(({ threadId }) => {
    if (!activeByThread.get(threadId)?.agent) return null;
    return agentNagInstruction;
  });

  // -------------------------------------------------------------------------
  // CLI — universal path for any agent/harness (just a shell command)
  // -------------------------------------------------------------------------
  bb.cli.register({
    name: "pinpoint",
    summary: "Visual feedback pinned in the Pinpoint browser",
    commands: [
      { name: "list", summary: "List feedback", usage: cmdList },
      { name: "show", summary: "Show one item", usage: cmdShow() },
      { name: "comment", summary: "Leave a comment for the user to review", usage: cmdComment },
      { name: "ready", summary: "Mark ready for review", usage: cmdReady() },
      { name: "ask", summary: "Ask the user a blocking question", usage: cmdAsk() },
      { name: "reject", summary: "Reject an item", usage: cmdReject() },
      { name: "approve", summary: "Approve (user)", usage: cmdApprove() },
      { name: "delete", summary: "Delete an item permanently", usage: cmdDelete() },
      { name: "status", summary: "Counts and config", usage: cmdStatus },
    ],
    async run(argv, cliCtx) {
      const [cmd, ...rest] = argv;
      const flag = (name: string) => {
        const i = rest.indexOf(`--${name}`);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const positional = rest.filter((a) => !a.startsWith("--"));
      const projectId = await projectFor(cliCtx);
      const ok = (stdout: string) => ({ exitCode: 0, stdout });
      const err = (stderr: string) => ({ exitCode: 1, stderr });
      // Reject cross-project ids on every mutation: when the invocation has a
      // resolvable project, the item must belong to it.
      const crossProject = (row: DbRow): string | null =>
        projectId && row.project_id && row.project_id !== projectId
          ? `item ${row.id} belongs to another project`
          : null;
      switch (cmd) {
        case "list": {
          if (!projectId) return err("no project context (pass --thread or run inside a thread)");
          const rows = listForProject(
            projectId,
            flag("status") as WorkflowState | undefined,
            !cliCtx.threadId,
          );
          if (!rows.length) return ok("(no matching feedback)\n");
          return ok(
            rows
              .map((r) => {
                const a = r.annotation;
                const where =
                  a.pinpoint.selector ?? a.elementPath ?? a.element ?? "?";
                const page = a.pinpoint.pathname ?? a.url ?? "";
                return `${a.id}  [${r.workflowState}]  ${where}  ${page}\n    ${a.comment || "(no comment)"}`;
              })
              .join("\n") + "\n",
          );
        }
        case "comment": {
          if (!projectId) return err("no project context (pass --thread or run inside a thread)");
          const threadId = cliCtx.threadId;
          if (!threadId)
            return err("run inside a thread (or pass --thread) to leave a comment");
          const url = flag("url");
          const selector = flag("selector");
          const comment = flag("comment") ?? positional.join(" ").trim();
          if (!url)
            return err(
              'usage: bb pinpoint comment --url <page-url> --selector <css> --comment "<text>"',
            );
          if (!comment) return err("--comment (or a positional message) is required");
          const row = createAgentComment({
            threadId,
            projectId,
            url,
            selector,
            comment,
            pathname: flag("pathname"),
            nearbyText: flag("near"),
          });
          return ok(`left comment ${row.id} for review (yellow / awaiting the user)\n`);
        }
        case "show": {
          const r = getRow(positional[0] ?? "");
          if (!r) return err(`no such item: ${positional[0] ?? ""}`);
          if (cliCtx.threadId && heldForOwner(r)) return err("Guest feedback needs owner approval in Guest feedback.");
          // The CLI surfaces screenshot PRESENCE only (already in the row's
          // `screenshots` field); pixels come from the pinpoint_show tool.
          const kinds =
            annotationFor(r).kind === "text-edit"
              ? []
              : screenshotKindsFor(db, r.id);
          const note = kinds.length
            ? `\nscreenshots stored: ${kinds.join(", ")} — view the pixels with the pinpoint_show tool.\n`
            : "\n";
          return ok(JSON.stringify(cliCtx.threadId ? toAgentOut(r) : toOut(r), null, 2) + note);
        }
        case "ready":
        case "resolve": {
          const id = positional[0];
          const row = id ? getRow(id) : null;
          if (!id || !row) return err(`no such item: ${id ?? ""}`);
          const cross = crossProject(row);
          if (cross) return err(cross);
          let scope: { breadth: ScopeBreadth; target: ScopeTarget } | undefined;
          const scopeRaw = flag("scope");
          if (scopeRaw !== undefined) {
            const parsed = parseScopeFlag(scopeRaw);
            if (!parsed.ok) return err(`${parsed.error}\nusage: ${cmdReady()}\n`);
            scope = parsed.scope;
          }
          let receipt: string | undefined;
          const receiptPath = flag("receipt-file");
          if (receiptPath !== undefined) {
            if (!receiptPath) return err(`usage: ${cmdReady()}\n`);
            const read = readReceiptFile(receiptPath);
            if (!read.ok) return err(`${read.error}\n`);
            receipt = read.text;
          }
          let proposedLearning;
          const learningRaw = flag("learning");
          if (learningRaw !== undefined) {
            if (!learningRaw) return err(`usage: ${cmdReady()}\n`);
            const parsed = parseLearningFlag(learningRaw);
            if (!parsed.ok) return err(`${parsed.error}\nusage: ${cmdReady()}\n`);
            proposedLearning = parsed.learning;
          }
          const result = resolveOutcome({
            id,
            outcome: "ready",
            summary: flag("summary"),
            scope,
            receipt,
            proposedLearning,
          });
          if (!result.ok) return err(`${result.error}\n`);
          // AE3: the resolution applied; a dropped proposal is reported, not
          // an error.
          const learningNote = result.learningRejected
            ? `note: your proposed learning was NOT kept: ${result.learningRejected}\n`
            : "";
          return ok(`marked ${id} ready for review\n${learningNote}`);
        }
        case "ask": {
          // Agent-callable (thread context allowed) — the question loop is the
          // agent asking the USER; only cross-project ids are rejected.
          const id = positional[0];
          const row = id ? getRow(id) : null;
          if (!id || !row) return err(`no such item: ${id ?? ""}`);
          const cross = crossProject(row);
          if (cross) return err(cross);
          const question = flag("question") ?? positional.slice(1).join(" ").trim();
          if (!question) return err(`usage: ${cmdAsk()}\n`);
          const result = resolveOutcome({ id, outcome: "question", question });
          if (!result.ok) return err(`${result.error}\n`);
          return ok(`asked — ${id} is now waiting for the user's input\n`);
        }
        case "reject": {
          const id = positional[0];
          const row = id ? getRow(id) : null;
          if (!id || !row) return err(`no such item: ${id ?? ""}`);
          const cross = crossProject(row);
          if (cross) return err(cross);
          const result = resolveOutcome({
            id,
            outcome: "reject",
            summary: flag("reason"),
          });
          if (!result.ok) return err(`${result.error}\n`);
          return ok(`rejected ${id}\n`);
        }
        case "approve": {
          // Human-only: approval is the reviewer accepting the work. An agent
          // invocation carries a thread context and must not approve for them.
          if (cliCtx.threadId)
            return err(
              "approve is reserved for the user: it cannot run with a thread context",
            );
          const id = positional[0];
          const row = id ? getRow(id) : null;
          if (!id || !row) return err(`no such item: ${id ?? ""}`);
          const cross = crossProject(row);
          if (cross) return err(cross);
          const result = approveAnnotation(id);
          if (!result.ok) return err(`${result.error}\n`);
          return ok(`approved ${id}\n`);
        }
        case "delete": {
          // Human-only, same guard as approve: deletion is irreversible.
          if (cliCtx.threadId)
            return err(
              "delete is reserved for the user: it cannot run with a thread context",
            );
          const id = positional[0];
          const row = id ? getRow(id) : null;
          if (!id || !row) return err(`no such item: ${id ?? ""}`);
          const cross = crossProject(row);
          if (cross) return err(cross);
          const result = await deleteAnnotation(id);
          if (!result.ok) return err(`${result.error}\n`);
          return ok(`deleted ${id}\n`);
        }
        case "status": {
          const s = await settings.get();
          const tally: Record<WorkflowState, number> = {
            open: 0,
            dispatched: 0,
            "waiting-input": 0,
            ready: 0,
            approved: 0,
            dismissed: 0,
          };
          if (projectId) {
            const dbRows = db
              .prepare(`SELECT * FROM annotations WHERE project_id=?`)
              .all(projectId) as DbRow[];
            const kinds = screenshotKindsForMany(db, dbRows.map((r) => r.id));
            for (const r of dbRows.map((row) => toOut(row, kinds.get(row.id) ?? [])))
              tally[r.workflowState] += 1;
          }
          return ok(
            `relayMode=${s.relayMode} autoDispatch=${s.autoDispatch} defaultUrl=${s.defaultUrl}\n` +
              (Object.entries(tally)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `  ${k}: ${n}`)
                .join("\n") || "  (no items)") +
              "\n",
          );
        }
        default:
          return err(
            "usage: bb pinpoint <list|show|comment|ready|ask|reject|approve|delete|status>",
          );
      }
    },
  });

  async function projectFor(ctx: {
    projectId?: string;
    threadId?: string;
  }): Promise<string | null> {
    if (ctx.projectId) return ctx.projectId;
    if (ctx.threadId) {
      try {
        return (await threadMeta(ctx.threadId)).projectId;
      } catch {
        return null;
      }
    }
    return null;
  }

  bb.onDispose(() => {
    previews.clear();
    guestScreenshots.clear();
  });
}

// ---------------------------------------------------------------------------
function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Same-origin assets stay within the resource capability. Declared public CDN
// resources remain subject to the document's CSP.
function rewriteAssets(
  html: string,
  target: URL,
  proxyBase: string,
): string {
  const wrap = (u: string): string | null => {
    let a: URL;
    try {
      a = new URL(u, target.href);
    } catch {
      return null;
    }
    if (a.origin !== target.origin) return null;
    return previewResourceUrl(proxyBase, a);
  };
  // Attribute values are HTML-encoded: "?url=x&amp;w=48" must be decoded to a
  // real URL before parsing, else "&amp;" leaks into the proxied query (Next's
  // /_next/image then sees a bogus "amp;w" param and 400s). encodeURIComponent
  // in wrap() re-escapes the result, so no re-encoding is needed here.
  const decodeEntities = (s: string): string =>
    s
      .replace(/&amp;/gi, "&")
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) =>
        String.fromCodePoint(parseInt(h, 16)),
      );
  html = html.replace(
    /(<(?:script|link|img|source|iframe)\b[^>]*?\b(?:src|href)\s*=\s*)(["'])(.*?)\2/gi,
    (m: string, pre: string, q: string, val: string) => {
      if (/^(data:|blob:|#|javascript:|mailto:)/i.test(val)) return m;
      const w = wrap(decodeEntities(val));
      return w ? `${pre}${q}${escapeAttr(w)}${q}` : m;
    },
  );
  html = html.replace(
    /(\bsrcset\s*=\s*)(["'])(.*?)\2/gi,
    (m: string, pre: string, q: string, val: string) => {
      const parts = val.split(",").map((p) => {
        const seg = p.trim();
        const sp = seg.split(/\s+/);
        const w = sp[0] ? wrap(decodeEntities(sp[0])) : null;
        return w ? [w, ...sp.slice(1)].join(" ") : seg;
      });
      return `${pre}${q}${parts.join(", ")}${q}`;
    },
  );
  html = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m: string, open: string, body: string, close: string) =>
      `${open}${rewriteCss(body, target, proxyBase)}${close}`,
  );
  html = html.replace(
    /style\s*=\s*(["'])(.*?)\1/gi,
    (_m: string, q: string, val: string) =>
      `style=${q}${rewriteCss(val, target, proxyBase)}${q}`,
  );
  return html;
}

function rewriteCss(
  css: string,
  base: URL,
  proxyBase: string,
): string {
  const wrap = (u: string): string | null => {
    if (/^(data:|#)/i.test(u)) return null;
    let a: URL;
    try {
      a = new URL(u, base.href);
    } catch {
      return null;
    }
    if (a.origin !== base.origin) return null;
    return previewResourceUrl(proxyBase, a);
  };
  css = css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (m: string, q: string, v: string) => {
      const w = wrap(v);
      return w ? `url(${q}${w}${q})` : m;
    },
  );
  css = css.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (m: string, q: string, v: string) => {
      const w = wrap(v);
      return w ? `@import ${q}${w}${q}` : m;
    },
  );
  return css;
}

// Injected first: re-route the app's runtime same-origin requests (fetch, XHR,
// dynamically-set resource URLs) back through the proxy, since the
// static rewrite above can't see URLs the app builds at runtime.
export function proxyShim(
  targetHref: string,
  proxyBase: string,
): string {
  const quote = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");
  return `(function(){var T=${quote(targetHref)},P=${quote(proxyBase)},O,H=location.hash;try{O=new URL(T).origin;}catch(_){O="";}
function storage(name){try{if(window[name])return;}catch(_){}var data=Object.create(null),keys=[];var value={get length(){return keys.length;},key:function(i){return keys[i]===undefined?null:keys[i];},getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(data,k)?data[k]:null;},setItem:function(k,v){k=String(k);if(!Object.prototype.hasOwnProperty.call(data,k))keys.push(k);data[k]=String(v);},removeItem:function(k){k=String(k);if(!Object.prototype.hasOwnProperty.call(data,k))return;delete data[k];keys.splice(keys.indexOf(k),1);},clear:function(){data=Object.create(null);keys=[];}};try{Object.defineProperty(window,name,{configurable:true,enumerable:true,value:value});}catch(_){}}
storage('localStorage');storage('sessionStorage');
function wrap(u,base){try{if(u==null)return u;var s=String(u);if(!s||s.indexOf(P+'/')===0||/^(data:|blob:|#|javascript:)/i.test(s))return u;var a=new URL(s,base||T);if(a.origin!==O)return u;return P+a.pathname+a.search+a.hash;}catch(_){return u;}}
window.__pinpointResourceUrl=wrap;
window.__pinpointModuleUrl=function(value,base){return wrap(value,base);};
window.__pinpointImport=function(base,specifier,options){return import(wrap(specifier,base),options);};
window.__pinpointTargetUrl=function(){var u=new URL(T);if(location.hash!==H)u.hash=location.hash;return u;};
function wset(v){try{return String(v).split(',').map(function(p){var s=p.trim(),i=0;while(i<s.length&&s.charCodeAt(i)>32)i++;if(!i)return s;return String(wrap(s.slice(0,i)))+s.slice(i);}).join(', ');}catch(_){return v;}}
var of=window.fetch;if(of)window.fetch=function(i,init){try{if(typeof i==='string')i=wrap(i);else if(i&&i.url)i=new Request(wrap(i.url),i);}catch(_){}init=Object.assign({},init||{},{credentials:'omit'});return of.call(this,i,init);};
var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=wrap(u);}catch(_){}return oo.apply(this,arguments);};
function patch(pr,p,fn){try{var d=Object.getOwnPropertyDescriptor(pr,p);if(!d||!d.set)return;Object.defineProperty(pr,p,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,(fn||wrap)(v));}});}catch(_){}}
var os=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){this.withCredentials=false;return os.apply(this,arguments);};
patch(HTMLScriptElement.prototype,'src');patch(HTMLLinkElement.prototype,'href');patch(HTMLImageElement.prototype,'src');patch(HTMLImageElement.prototype,'srcset',wset);if(typeof HTMLSourceElement!=='undefined'){patch(HTMLSourceElement.prototype,'src');patch(HTMLSourceElement.prototype,'srcset',wset);}
var sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){try{var k=n&&n.toLowerCase(),tag=this.tagName&&this.tagName.toLowerCase();if(k==='src'||(k==='href'&&tag==='link'))v=wrap(v);else if(k==='srcset'&&(tag==='img'||tag==='source'))v=wset(v);}catch(_){}return sa.call(this,n,v);};
function unwrap(u){try{var p=new URL(P,location.href),a=new URL(String(u),location.href);if(a.origin===p.origin&&a.pathname.indexOf(p.pathname+'/')===0)return O+a.pathname.slice(p.pathname.length)+a.search+a.hash;}catch(_){}return u;}
function reveal(pr,p){try{var d=Object.getOwnPropertyDescriptor(pr,p);if(!d||!d.get)return;Object.defineProperty(pr,p,{configurable:true,enumerable:d.enumerable,get:function(){return unwrap(d.get.call(this));},set:d.set});}catch(_){}}
reveal(HTMLImageElement.prototype,'currentSrc');
function histUrl(u){try{if(u==null)return u;var a=new URL(String(unwrap(u)),T);if(a.origin!==O)return u;return wrap(a.href);}catch(_){return u;}}
function nav(){try{window.dispatchEvent(new Event('bb-pinpoint-navigation'));}catch(_){}}
var ph=history.pushState,rh=history.replaceState,hs=Object.getOwnPropertyDescriptor(History.prototype,'state');
function historyEntry(s,u,h){return {__pinpointHistory:1,scope:P,url:u,hash:h,state:s};}
function readHistoryEntry(s){if(!s||s.__pinpointHistory!==1||s.scope!==P||typeof s.url!=='string'||typeof s.hash!=='string')return null;try{return new URL(s.url).origin===O?s:null;}catch(_){return null;}}
function restoreHistory(u,h){T=u;H=h;var b=document.querySelector('base');if(b)b.href=window.__pinpointTargetUrl().href;}
function setHistory(fn,self,s,t,u){var next=u==null?window.__pinpointTargetUrl():new URL(String(unwrap(u)),window.__pinpointTargetUrl());if(next.origin!==O)throw new DOMException('History cannot leave the selected preview origin.','SecurityError');var mapped=histUrl(u),entry=historyEntry(s,next.href,u==null?location.hash:new URL(String(mapped),location.href).hash),r;try{r=fn.call(self,entry,t,mapped);}catch(e){if(!e||e.name!=='SecurityError')throw e;entry.hash=location.hash;r=fn.call(self,entry,t);}restoreHistory(next.href,location.hash);nav();return r;}
try{
  var initial=hs&&hs.get?hs.get.call(history):history.state,previous=readHistoryEntry(initial);
  rh.call(history,historyEntry(previous?previous.state:initial,T,H),document.title);
  if(hs&&hs.get)Object.defineProperty(history,'state',{configurable:true,enumerable:hs.enumerable,get:function(){var raw=hs.get.call(this),entry=readHistoryEntry(raw);return entry?entry.state:raw;}});
  history.pushState=function(s,t,u){return setHistory(ph,this,s,t,u);};
  history.replaceState=function(s,t,u){return setHistory(rh,this,s,t,u);};
  window.addEventListener('popstate',function(e){var entry=readHistoryEntry(e.state);if(entry){restoreHistory(entry.url,entry.hash);Object.defineProperty(e,'state',{configurable:true,value:entry.state});}nav();},true);
}catch(_){}
function wcss(t){try{return String(t).replace(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g,function(m,q,u){var w=wrap(u);return w!==u?('url('+q+w+q+')'):m;});}catch(_){return t;}}
function fixStyle(el){try{if(el&&el.tagName==='STYLE'){var t=el.textContent||'';var n=wcss(t);if(n!==t)el.textContent=n;}}catch(_){}}
function scan(root){try{if(!root||root.nodeType!==1)return;fixStyle(root);if(root.querySelectorAll)Array.prototype.forEach.call(root.querySelectorAll('style'),fixStyle);}catch(_){}}
try{var mo=new MutationObserver(function(ms){ms.forEach(function(m){if(m.addedNodes)Array.prototype.forEach.call(m.addedNodes,scan);if(m.type==='characterData'&&m.target&&m.target.parentNode)fixStyle(m.target.parentNode);});});mo.observe(document.documentElement||document,{childList:true,subtree:true,characterData:true});}catch(_){}
if(document.addEventListener)document.addEventListener('DOMContentLoaded',function(){scan(document.documentElement);});
scan(document.documentElement);
})();`;
}
