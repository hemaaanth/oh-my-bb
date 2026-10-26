import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { Suspense, useId } from "react";
import { z } from "zod";
import { useHost } from "../host.js";
import type { Group } from "../kit.js";

const App = defineComponent({
  name: "App",
  props: z.object({ name: z.string(), html: z.string() }),
  description: "Self-contained HTML/JavaScript for a custom visual, game or simulation. name is stable within this block and keys its saved state. Scripts run only after the fence closes. The opaque iframe blocks fetches and remote resource loads, but it can navigate its own frame and make a network request. Embed assets and code. localStorage persists up to 256 KB per app, with a 1 MB total budget; sessionStorage is memory-only. genui.answer(text) stages an answer for review in BB; null removes it. genui.canAnswer is false on published pages and downloads. genui.openLink(httpsUrl) requests a link from a user gesture. genui.reducedMotion and matchMedia expose motion preferences. Use CSS theme variables and the SVG kit classes t, ts, th, box, arr, leader and tone-good/warn/bad/info/accent. App actions include pane-scoped full screen, download, source, and sandbox limits.",
  component: ({ props }) => {
    const host = useHost();
    const streaming = useIsStreaming();
    const instance = useId();
    const stateKey = `${host.blockKey ?? `gallery:${instance}`}|app:${props.name}`;
    return <Suspense fallback={<div role="status" className="flex h-20 items-center text-xs text-muted-foreground">Loading app…</div>}><host.App html={props.html} ready={host.appsReady && !streaming} stateKey={stateKey} persist={host.kind !== "gallery" && host.blockKey !== null} /></Suspense>;
  },
});

const counter = `<title>Counter</title>
<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:8px">
<button id="minus" aria-label="Decrease">−</button><output id="value" style="min-width:3ch;text-align:center;font-size:24px;font-variant-numeric:tabular-nums"></output><button id="plus" aria-label="Increase">+</button>
<button id="answer">Use count</button>
</div>
<script>
let count = Number(localStorage.getItem('count') || 0);
const value = document.getElementById('value');
function draw() { value.textContent = count; localStorage.setItem('count', String(count)); }
document.getElementById('minus').onclick = () => { count--; draw(); };
document.getElementById('plus').onclick = () => { count++; draw(); };
const answer = document.getElementById('answer');
answer.hidden = !genui.canAnswer;
answer.onclick = () => genui.answer('Count: ' + count);
draw();
</script>`;
const diagram = `<title>Request flow</title>
<svg viewBox="0 0 560 160" role="img" aria-label="Browser requests API, API reads database" style="width:100%;height:auto">
<g class="tone-info"><rect class="box" x="8" y="46" width="132" height="64" rx="6"/><text class="th" x="74" y="84" text-anchor="middle">Browser</text></g>
<path class="arr" d="M148 78H210" marker-end="url(#genui-arrow)"/><text class="ts" x="180" y="55" text-anchor="middle">request</text>
<g class="tone-accent"><rect class="box" x="218" y="46" width="124" height="64" rx="6"/><text class="th" x="280" y="84" text-anchor="middle">API</text></g>
<path class="arr" d="M350 78H412" marker-end="url(#genui-arrow)"/><text class="ts" x="382" y="55" text-anchor="middle">query</text>
<g class="tone-good"><rect class="box" x="420" y="46" width="132" height="64" rx="6"/><text class="th" x="486" y="84" text-anchor="middle">Database</text></g>
</svg>`;

export const group: Group = {
  id: "apps", name: "Apps",
  notes: ["Use an app or pages-app fence for raw HTML, or App(name, html) inside OpenUI. The sandbox is not a strict network-isolation boundary: same-frame navigation remains possible. Never put secrets in an app. Existing Pages forms still send directly; app answers stage in the composer."],
  entries: [{ component: App, summary: "sandboxed HTML, simulations, and custom visuals", examples: [
    { name: "Persistent counter", code: `root = App("counter", ${JSON.stringify(counter)})` },
    { name: "SVG diagram kit", code: `root = App("request-flow", ${JSON.stringify(diagram)})` },
  ] }],
};
