import { useEffect, useRef, type ReactNode } from "react";
import { experimental_Icon as Icon, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Gallery } from "./Gallery.js";
import { LIBRARY_PATH } from "./PageView.js";
import { focusRing } from "./ui.js";

export const PAGES_ICON = "pages/pages";
const button = `inline-flex h-8 w-full shrink-0 items-center justify-center rounded-md border border-border bg-transparent px-3 text-xs font-medium hover:bg-state-hover @md:w-44 ${focusRing}`;

export function PagesSettings() {
  const navigate = useBbNavigate();
  const links = [
    { title: "Library", note: "Browse pages by project and folder.", action: "Open library", path: "" },
    { title: "Component gallery", note: "Live examples with source, in BB and site themes.", action: "Browse components", path: "components" },
    { title: "Setup guide", note: "Optional sharing, map tiles, and web lookups.", action: "Open setup guide", path: "setup" },
  ];
  return <section className="@container space-y-4">
    <h2 className="text-sm font-medium text-foreground">More</h2>
    <div className="divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3">
      {links.map((link) => <div key={link.title} className="flex flex-col items-stretch gap-2.5 py-3 @md:flex-row @md:items-center @md:justify-between @md:gap-5">
        <div className="min-w-0 flex-1"><p className="text-sm text-foreground">{link.title}</p><p className="mt-0.5 text-xs leading-snug text-muted-foreground">{link.note}</p></div>
        <button type="button" className={button} onClick={() => navigate.toPluginPanel(LIBRARY_PATH, link.path ? { subPath: link.path } : undefined)}>{link.action}</button>
      </div>)}
    </div>
  </section>;
}

function ReferencePage({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <main className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
    <div className="mx-auto w-full max-w-[760px] space-y-5 px-4 py-6">
      <UrlLink href="/settings/plugins/pages" className={`inline-flex h-5 items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground ${focusRing}`}><Icon name="ChevronLeft" aria-hidden className="size-3.5" />Settings</UrlLink>
      <header className="flex items-center gap-3">
        <Icon name={PAGES_ICON} aria-hidden className="size-9 shrink-0" />
        <div className="min-w-0"><h1 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">{title}</h1><p className="text-xs text-muted-foreground">{subtitle}</p></div>
      </header>
      {children}
    </div>
  </main>;
}

export function GalleryPage() {
  return <ReferencePage title="Component gallery" subtitle="Live examples and source for chat and pages."><Gallery /></ReferencePage>;
}

export function PagesSetup() {
  return <ReferencePage title="Set up Pages" subtitle="Local pages need no setup. Add keys only for optional features.">
    <div className="divide-y divide-border/60 rounded-md border border-border bg-surface-recessed/70 px-3 text-sm">
      <section className="space-y-2 py-3">
        <h2 className="font-medium">Sharing</h2>
        <p className="text-muted-foreground">Add a Here.now API key in Configuration. Open a page and choose Share. Confirm its access before creating the link.</p>
        <p className="text-muted-foreground">Restricted access uses verified emails or domains. Password access requires a password. Anyone with the link is public. New shares use your defaults; existing shares keep their access.</p>
        <UrlLink href="https://here.now" className={`inline-flex items-center gap-1 text-xs underline underline-offset-2 ${focusRing}`}>Open Here.now<Icon name="ExternalLink" aria-hidden className="size-3" /></UrlLink>
      </section>
      <section className="space-y-2 py-3">
        <h2 className="font-medium">Maps and web lookups</h2>
        <p className="text-muted-foreground">A Mapbox token adds map tiles. Without it, maps show places on a blank grid. Web lookups fetch tiles from Mapbox, place names from Photon, photos from Wikimedia Commons, and linked images through the Pages server.</p>
        <p className="text-muted-foreground">Turn off Web lookups in Configuration to stop these fetches. Published pages keep the data saved when they were published.</p>
        <UrlLink href="https://account.mapbox.com/access-tokens/" className={`inline-flex items-center gap-1 text-xs underline underline-offset-2 ${focusRing}`}>Manage Mapbox tokens<Icon name="ExternalLink" aria-hidden className="size-3" /></UrlLink>
      </section>
      <section className="space-y-2 py-3">
        <h2 className="font-medium">Charts</h2>
        <p className="text-muted-foreground">Pages includes Highcharts. You must obtain the license your use requires. Installing Pages does not grant one.</p>
        <UrlLink href="https://www.highcharts.com/license" className={`inline-flex items-center gap-1 text-xs underline underline-offset-2 ${focusRing}`}>Highcharts licensing<Icon name="ExternalLink" aria-hidden className="size-3" /></UrlLink>
      </section>
    </div>
  </ReferencePage>;
}
