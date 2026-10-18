// The component gallery on the Pages settings page: every catalog example, rendered live with the
// same Renderer and the live theme, with its source. Look only: buttons lock here but send nothing.
// The Site look shows each example the way a published page draws it: page tokens, and read-only replies.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { BuiltinActionType, Renderer, type ActionEvent } from "@openuidev/react-lang";
import { GROUPS, specLibrary } from "./spec/catalog.js";
import { HostContext, fallbackHost, type Host } from "./spec/host.js";
import { lightText } from "./spec/groups/media-logic.js";
import { Chevron, Reveal, SentContext, field, fixtureTools, focusRing, type Entry, type Example } from "./spec/kit.js";
import { useBbHost } from "./specHost.js";
import { siteLook } from "../render/spec-runtime/css.js";
import themeCss from "../assets/theme.css" with { type: "text" };

type Look = "bb" | "site";
const LOOKS: { id: Look; name: string }[] = [{ id: "bb", name: "BB" }, { id: "site", name: "Site" }];

/** The host a page gives the components, with BB's live lookups, since the gallery has nothing baked. */
const siteHost = (host: Host): Host => ({ ...host, kind: "page", replies: false, SourceCode: fallbackHost.SourceCode, Diff: fallbackHost.Diff, Markdown: fallbackHost.Markdown });

function ExampleView({ example, host, look, named }: { example: Example; host: Host; look: Host; named: boolean }) {
  const [sent, setSent] = useState<Record<string, string>>({});
  const sentValue = useMemo(() => ({ sent, unlock: (form: string) => setSent(({ [form]: _, ...rest }) => rest) }), [sent]);
  const tools = useMemo(() => fixtureTools(example.tools), [example.tools]);
  const [source, setSource] = useState(false);
  const onAction = (event: ActionEvent) => {
    if (event.type === BuiltinActionType.OpenUrl) host.openUrl(String(event.params.url ?? ""));
    if (event.type === BuiltinActionType.ContinueConversation) setSent((current) => ({ ...current, [event.formName ?? ""]: event.humanFriendlyMessage || "sent" }));
  };
  return <figure className="m-0 flex min-w-0 flex-col gap-2">
    {named ? <figcaption className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground/75">{example.name}</figcaption> : null}
    <HostContext.Provider value={look}>
      <SentContext.Provider value={sentValue}>
        <Renderer response={example.code} library={specLibrary} isStreaming={false} onAction={onAction} toolProvider={tools} />
      </SentContext.Provider>
    </HostContext.Provider>
    <div className="min-w-0">
      <button type="button" aria-expanded={source} onClick={() => setSource(!source)} className={`flex w-fit cursor-pointer items-center gap-1 rounded-sm text-xs text-subtle-foreground hover:text-foreground ${focusRing}`}><Chevron open={source} />Source</button>
      <Reveal open={source} className="pt-2"><host.SourceCode content={example.code} path="example.openui" /></Reveal>
    </div>
  </figure>;
}

function EntryView({ entry, host, look }: { entry: Entry; host: Host; look: Host }) {
  return <section aria-label={entry.component.name} className="flex min-w-0 flex-col gap-3 py-4">
    <div className="flex flex-wrap items-baseline gap-x-2"><h3 className="m-0 text-sm font-medium text-foreground">{entry.component.name}</h3><span className="text-xs text-subtle-foreground">{entry.summary}</span></div>
    {entry.examples.map((example) => <ExampleView key={example.name} example={example} host={host} look={look} named={entry.examples.length > 1} />)}
  </section>;
}

export function Gallery() {
  const host = useBbHost("gallery");
  const [look, setLook] = useState<Look>("bb");
  const lookHost = useMemo(() => look === "site" ? siteHost(host) : host, [look, host]);
  // The site look follows BB's theme: dark text on the gallery means a light theme.
  const box = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(false);
  useLayoutEffect(() => { if (box.current) setDark(lightText(getComputedStyle(box.current).color)); }, [look]);
  const groups = GROUPS.filter((group) => group.entries.some((entry) => !entry.part));
  const [active, setActive] = useState(groups[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? groups.flatMap((group) => group.entries).filter((entry) => !entry.part && `${entry.component.name} ${entry.summary}`.toLowerCase().includes(needle))
    : (groups.find((group) => group.id === active) ?? groups[0])?.entries.filter((entry) => !entry.part) ?? [];
  const count = groups.reduce((sum, group) => sum + group.entries.filter((entry) => !entry.part).length, 0);
  return <HostContext.Provider value={host}>
    <div ref={box} className="flex min-w-0 flex-col gap-3 text-sm">
      {look === "site" ? <style>{siteLook(themeCss, ".bb-site-look", dark)}</style> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <input type="search" aria-label="Search components" placeholder={`Search ${count} components`} value={query} onChange={(event) => setQuery(event.target.value)} className={`${field} h-8 max-w-xs py-1 text-sm`} />
        <div role="radiogroup" aria-label="Look" className="flex items-center gap-x-3 text-xs">
          {LOOKS.map(({ id, name }) => <button key={id} type="button" role="radio" aria-checked={look === id} onClick={() => setLook(id)} className={`cursor-pointer rounded-sm ${focusRing} ${look === id ? "text-foreground underline underline-offset-4" : "text-subtle-foreground hover:text-foreground"}`}>{name}</button>)}
        </div>
      </div>
      {needle ? null : <div role="tablist" aria-label="Component groups" className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border">
        {groups.map((group) => <button key={group.id} type="button" role="tab" aria-selected={group.id === active} onClick={() => setActive(group.id)} className={`-mb-px cursor-pointer border-b pb-1.5 text-sm ${focusRing} ${group.id === active ? "border-foreground text-foreground" : "border-transparent text-subtle-foreground hover:text-foreground"}`}>{group.name}</button>)}
      </div>}
      {/* Previews keep chat's reading width, so they look the way they will in a reply. */}
      {shown.length ? <div className={`flex max-w-2xl flex-col divide-y divide-border ${look === "site" ? "bb-site-look px-4" : ""}`}>{shown.map((entry) => <EntryView key={entry.component.name} entry={entry} host={host} look={lookHost} />)}</div> : <p className="m-0 py-2.5 text-subtle-foreground">No component matches.</p>}
    </div>
  </HostContext.Provider>;
}
