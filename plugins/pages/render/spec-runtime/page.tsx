// The page side of openui-lang blocks: the Host and Query tools a published page or shared site gives the
// chat components. A page has no server to ask, so both read the answers the publish baked into it
// (server/spec/bake.ts). Nothing here sends to a thread: components that would reply turn read-only.
import { createRoot } from "react-dom/client";
import { BuiltinActionType, Renderer, type ActionEvent, type OpenUIError } from "@openuidev/react-lang";
import type { SpecResult } from "../../contract.js";
import { specLibrary } from "../../app/spec/catalog.js";
import { HostContext, fallbackHost, type Host, type WebMethod } from "../../app/spec/host.js";
import type { Tools } from "../../app/spec/kit.js";
import { specTools } from "../../app/spec/tools.js";
import { BAKED_ATTRIBUTE, SPEC_TYPE, bakedKey, unescapeSpec, type Baked } from "../spec-baked.js";

const answer = (result: SpecResult | undefined, missing: string): Promise<unknown> =>
  !result ? Promise.reject(new Error(missing)) : result.ok ? Promise.resolve(result.data) : Promise.reject(new Error(result.message));

const missingWeb: Record<WebMethod, string> = {
  tile: "Some map tiles were not saved with this page.",
  geocode: "This place was not saved with the page.",
  search: "These photos were not saved with the page.",
  image: "This image was not saved with the page.",
};

/**
 * Opens a link through a plain <a>, so the BB preview's frame bridge sees the click and asks BB to open it.
 * A published page opens it in a new tab.
 */
function openLink(url: string): void {
  if (!/^https?:\/\//iu.test(url)) return;
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

/** The Host on a page. Every field is set here, so a new Host field fails the type check until the page has it. */
export function pageHost(baked: Baked): Host {
  return {
    kind: "page",
    SourceCode: fallbackHost.SourceCode,
    Diff: fallbackHost.Diff,
    Markdown: fallbackHost.Markdown,
    web: (method, input) => answer(baked[bakedKey("web", method, input)], missingWeb[method]),
    openUrl: openLink,
    replies: false,
  };
}

/** The Renderer's toolProvider on a page: each listed tool answers from the baked results. */
export function bakedTools(baked: Baked): Tools {
  return Object.fromEntries(specTools.map(({ name }) => [name, (args: Record<string, unknown>) => answer(baked[bakedKey("tool", name, args)], `Query("${name}") was not saved with this page.`)]));
}

/** The baked answers on the page, or none. */
export function readBaked(root: ParentNode): Baked {
  const text = root.querySelector(`script[${BAKED_ATTRIBUTE}]`)?.textContent;
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Baked : {};
  } catch {
    return {};
  }
}

export type SpecBlockProps = { code: string; host: Host; tools: Tools; onError?: (errors: OpenUIError[]) => void };

/** One block on a page. Links open; a reply goes nowhere, since the components that send are read-only here. */
export function SpecBlock({ code, host, tools, onError }: SpecBlockProps) {
  const onAction = (event: ActionEvent) => {
    if (event.type === BuiltinActionType.OpenUrl) host.openUrl(String(event.params.url ?? ""));
  };
  return <HostContext.Provider value={host}>
    <Renderer response={code} library={specLibrary} isStreaming={false} toolProvider={tools} onAction={onAction} onError={onError} />
  </HostContext.Provider>;
}

/**
 * Draws every <script type="text/openui-lang"> in `doc`. Each block renders into an open shadow root right
 * after its script, so the page's theme.css never reaches the components and their CSS never reaches the page.
 * `css` is the component CSS (dist/app.css with the page token bridge). Returns how many blocks it drew.
 * `onError` gets each block's render errors; the page itself shows them in the block.
 */
export function mountSpecs(doc: Document, css: string, onError?: (errors: OpenUIError[], index: number) => void): number {
  const baked = readBaked(doc);
  const host = pageHost(baked);
  const tools = bakedTools(baked);
  let count = 0;
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>(`script[type="${SPEC_TYPE}"]`))) {
    if (script.hasAttribute("data-bb-spec-drawn")) continue;
    script.setAttribute("data-bb-spec-drawn", "");
    const index = count;
    const box = doc.createElement("div");
    box.className = "bb-spec";
    script.after(box);
    const shadow = box.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = css;
    // The plugin CSS is scoped to [data-bb-plugin=pages], the way BB scopes it in the app.
    const root = doc.createElement("div");
    root.setAttribute("data-bb-plugin-root", "");
    root.setAttribute("data-bb-plugin", "pages");
    shadow.append(style, root);
    createRoot(root).render(<SpecBlock code={unescapeSpec(script.textContent ?? "")} host={host} tools={tools} onError={onError ? (errors) => onError(errors, index) : undefined} />);
    count += 1;
  }
  return count;
}
