// Live component examples with source. Buttons lock here but send nothing.
// The Site look uses published-page tokens and read-only replies.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { PORTAL_SCOPE, menuContent, menuItem } from "./ui.js";
import { BuiltinActionType, type ActionEvent } from "@openuidev/react-lang";
import { GROUPS, specLibrary } from "./spec/catalog.js";
import { HostContext, fallbackHost, type Host } from "./spec/host.js";
import { lightText } from "./spec/groups/media-logic.js";
import { Chevron, Reveal, SentContext, field, fixtureTools, focusRing, type Entry, type Example } from "./spec/kit.js";
import { useBbHost } from "./specHost.js";
import { siteLook } from "../render/spec-runtime/css.js";
import themeCss from "../assets/theme.css" with { type: "text" };
import { annotateSources } from "./spec/source-metadata.js";
import { MotionBoundary } from "./spec/motion.js";
import { CopyMarkdown, MarkdownGroup, SpecRenderer } from "./spec/SpecRenderer.js";

type Look = "bb" | "site";
const LOOKS: { id: Look; name: string }[] = [{ id: "bb", name: "BB" }, { id: "site", name: "Site" }];

/** The host a page gives the components, with BB's live lookups, since the gallery has nothing baked. */
const siteHost = (host: Host): Host => ({ ...host, kind: "page", replies: false, App: fallbackHost.App, SourceCode: fallbackHost.SourceCode, Diff: fallbackHost.Diff, Markdown: fallbackHost.Markdown });

function ExampleView({ example, host, look, named }: { example: Example; host: Host; look: Host; named: boolean }) {
  const [sent, setSent] = useState<Record<string, string>>({});
  const sentValue = useMemo(() => ({ sent, unlock: (form: string) => setSent(({ [form]: _, ...rest }) => rest) }), [sent]);
  const tools = useMemo(() => fixtureTools(example.tools), [example.tools]);
  const previewHost = useMemo<Host>(() => ({ ...look, loadText: async (path) => {
    const file = example.tools?.file as { path?: unknown; text?: unknown } | undefined;
    return file?.path === path && typeof file.text === "string" ? file.text : look.loadText(path);
  } }), [look, example.tools]);
  const onAction = (event: ActionEvent) => {
    if (event.type === BuiltinActionType.OpenUrl) host.openUrl(String(event.params.url ?? ""));
    if (event.type === BuiltinActionType.ContinueConversation) setSent((current) => ({ ...current, [event.formName ?? ""]: event.humanFriendlyMessage || "sent" }));
  };
  return <figure className="m-0 flex min-w-0 flex-col gap-2 overflow-x-clip [overflow-clip-margin:4px]">
    {named ? <figcaption className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground/75">{example.name}</figcaption> : null}
    <HostContext.Provider value={previewHost}>
      <MotionBoundary>
      <SentContext.Provider value={sentValue}>
        <SpecRenderer response={example.code} library={specLibrary} isStreaming={false} onAction={onAction} toolProvider={tools} onParseResult={annotateSources} exportable={false} />
      </SentContext.Provider>
      </MotionBoundary>
    </HostContext.Provider>
  </figure>;
}

function EntryView({ entry, host, look }: { entry: Entry; host: Host; look: Host }) {
  return <section aria-label={entry.component.name} className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface-recessed/70 p-3">
    <div className="flex flex-wrap items-baseline gap-x-2"><h3 className="m-0 text-sm font-medium text-foreground">{entry.component.name}</h3><span className="text-xs text-subtle-foreground">{entry.summary}</span></div>
    {entry.examples.map((example) => <ExampleView key={example.name} example={example} host={host} look={look} named={entry.examples.length > 1} />)}
  </section>;
}

function EntrySource({ entry, host }: { entry: Entry; host: Host }) {
  const [open, setOpen] = useState(false);
  return <div className="min-w-0 py-2 first:pt-0 last:pb-0">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`flex w-full cursor-pointer items-center gap-1 rounded-sm text-left text-sm text-subtle-foreground hover:text-foreground ${focusRing}`}><Chevron open={open} />{entry.component.name}</button>
    <Reveal open={open} className="pt-3">
      <div className="flex min-w-0 flex-col gap-3">
        {entry.examples.map((example) => <div key={example.name} className="min-w-0">
          {entry.examples.length > 1 ? <h4 className="m-0 mb-2 text-2xs font-medium uppercase tracking-wide text-subtle-foreground/75">{example.name}</h4> : null}
          <host.SourceCode content={example.code} path="example.openui" />
        </div>)}
      </div>
    </Reveal>
  </div>;
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
  const selectedGroup = groups.find((group) => group.id === active) ?? groups[0];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? groups.flatMap((group) => group.entries).filter((entry) => !entry.part && `${entry.component.name} ${entry.summary}`.toLowerCase().includes(needle))
    : selectedGroup?.entries.filter((entry) => !entry.part) ?? [];
  const count = groups.reduce((sum, group) => sum + group.entries.filter((entry) => !entry.part).length, 0);
  return <HostContext.Provider value={host}><MarkdownGroup>
    <div ref={box} className="flex min-w-0 flex-col gap-3 text-sm">
      {look === "site" ? <style>{siteLook(themeCss, ".bb-site-look", dark)}</style> : null}
      <div className="flex min-w-0 items-center gap-2">
        <input type="search" aria-label="Search components" placeholder={`Search ${count} components`} value={query} onChange={(event) => setQuery(event.target.value)} className={`${field} h-8 flex-1 py-1 text-sm`} />
        {needle ? null : <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label={`Component category: ${selectedGroup?.name ?? ""}`} className={`inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-medium text-subtle-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-hover ${focusRing}`}>
              <span className="truncate">{selectedGroup?.name}</span><Icon name="ChevronDown" aria-hidden className="size-3 shrink-0" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content {...PORTAL_SCOPE} aria-label="Component categories" align="start" sideOffset={4} collisionPadding={8} style={{ zIndex: 75 }} className={`max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 max-w-[calc(100vw-16px)] overflow-y-auto ${menuContent}`}>
              <DropdownMenu.RadioGroup value={active} onValueChange={setActive}>
                {groups.map((group) => <DropdownMenu.RadioItem key={group.id} value={group.id} className={menuItem}>
                  <span className="flex w-3.5 shrink-0 justify-center"><DropdownMenu.ItemIndicator><Icon name="Check" aria-hidden className="size-3.5" /></DropdownMenu.ItemIndicator></span>
                  <span>{group.name}</span>
                </DropdownMenu.RadioItem>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>}
        <div role="radiogroup" aria-label="Look" className="flex shrink-0 items-center gap-x-3 whitespace-nowrap text-xs">
          {LOOKS.map(({ id, name }) => <button key={id} type="button" role="radio" aria-checked={look === id} onClick={() => setLook(id)} className={`cursor-pointer rounded-sm ${focusRing} ${look === id ? "text-foreground underline underline-offset-4" : "text-subtle-foreground hover:text-foreground"}`}>{name}</button>)}
        </div>
      </div>
      {shown.length ? <div className={`flex min-w-0 flex-col gap-3 ${look === "site" ? "bb-site-look" : ""}`}>{shown.map((entry) => <EntryView key={entry.component.name} entry={entry} host={host} look={lookHost} />)}</div> : <p className="m-0 py-2.5 text-subtle-foreground">No component matches.</p>}
      {shown.length ? <section aria-label="Sources" className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface-recessed/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="m-0 text-sm font-medium text-foreground">Sources</h3><CopyMarkdown /></div>
        <div className="min-w-0 divide-y divide-border">{shown.map((entry) => <EntrySource key={entry.component.name} entry={entry} host={host} />)}</div>
      </section> : null}
    </div>
  </MarkdownGroup></HostContext.Provider>;
}
