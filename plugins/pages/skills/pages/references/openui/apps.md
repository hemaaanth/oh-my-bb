# Apps

Use an app or pages-app fence for raw HTML, or App(name, html) inside OpenUI. The sandbox is not a strict network-isolation boundary: same-frame navigation remains possible. Never put secrets in an app. Existing Pages forms still send directly; app answers stage in the composer.

## App

`App(name: string, html: string)`

Self-contained HTML/JavaScript for a custom visual, game or simulation. name is stable within this block and keys its saved state. Scripts run only after the fence closes. The opaque iframe blocks fetches and remote resource loads, but it can navigate its own frame and make a network request. Embed assets and code. localStorage persists up to 256 KB per app, with a 1 MB total budget; sessionStorage is memory-only. genui.answer(text) stages an answer for review in BB; null removes it. genui.canAnswer is false on published pages and downloads. genui.openLink(httpsUrl) requests a link from a user gesture. genui.reducedMotion and matchMedia expose motion preferences. Use CSS theme variables and the SVG kit classes t, ts, th, box, arr, leader and tone-good/warn/bad/info/accent. App actions include pane-scoped full screen, download, source, and sandbox limits.

Persistent counter:

```openui-lang
root = App("counter", "<title>Counter</title>\n<div style=\"display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:8px\">\n<button id=\"minus\" aria-label=\"Decrease\">−</button><output id=\"value\" style=\"min-width:3ch;text-align:center;font-size:24px;font-variant-numeric:tabular-nums\"></output><button id=\"plus\" aria-label=\"Increase\">+</button>\n<button id=\"answer\">Use count</button>\n</div>\n<script>\nlet count = Number(localStorage.getItem('count') || 0);\nconst value = document.getElementById('value');\nfunction draw() { value.textContent = count; localStorage.setItem('count', String(count)); }\ndocument.getElementById('minus').onclick = () => { count--; draw(); };\ndocument.getElementById('plus').onclick = () => { count++; draw(); };\nconst answer = document.getElementById('answer');\nanswer.hidden = !genui.canAnswer;\nanswer.onclick = () => genui.answer('Count: ' + count);\ndraw();\n</script>")
```

SVG diagram kit:

```openui-lang
root = App("request-flow", "<title>Request flow</title>\n<svg viewBox=\"0 0 560 160\" role=\"img\" aria-label=\"Browser requests API, API reads database\" style=\"width:100%;height:auto\">\n<g class=\"tone-info\"><rect class=\"box\" x=\"8\" y=\"46\" width=\"132\" height=\"64\" rx=\"6\"/><text class=\"th\" x=\"74\" y=\"84\" text-anchor=\"middle\">Browser</text></g>\n<path class=\"arr\" d=\"M148 78H210\" marker-end=\"url(#genui-arrow)\"/><text class=\"ts\" x=\"180\" y=\"55\" text-anchor=\"middle\">request</text>\n<g class=\"tone-accent\"><rect class=\"box\" x=\"218\" y=\"46\" width=\"124\" height=\"64\" rx=\"6\"/><text class=\"th\" x=\"280\" y=\"84\" text-anchor=\"middle\">API</text></g>\n<path class=\"arr\" d=\"M350 78H412\" marker-end=\"url(#genui-arrow)\"/><text class=\"ts\" x=\"382\" y=\"55\" text-anchor=\"middle\">query</text>\n<g class=\"tone-good\"><rect class=\"box\" x=\"420\" y=\"46\" width=\"132\" height=\"64\" rx=\"6\"/><text class=\"th\" x=\"486\" y=\"84\" text-anchor=\"middle\">Database</text></g>\n</svg>")
```
