// The page runtime for openui-lang blocks (assets/spec.js): draws each <script type="text/openui-lang"> with
// the chat components and the answers baked in at publish time. build.mjs sets __APP_CSS__ from dist/app.css.
import { pageCss } from "./css.js";
import { mountSpecs } from "./page.js";

declare const __APP_CSS__: string;

const draw = () => { mountSpecs(document, pageCss(__APP_CSS__)); };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", draw, { once: true });
else draw();
