import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";

export const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ErrorMessage({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={COARSE_POINTER_HEADER_ICON_BUTTON_CLASS}
      aria-label="All agents"
      onClick={onClick}
    >
      <Icon name="ChevronLeft" className="size-4" />
    </Button>
  );
}

export function TabBar({
  items,
  selected,
  onSelect,
  label,
}: {
  items: readonly string[];
  selected: string;
  onSelect: (tab: string) => void;
  label: string;
}) {
  return (
    <nav className="bot-tabs" aria-label={label} role="tablist">
      {items.map((tab) => {
        const active = selected === tab;
        return (
          <Button
            variant="ghost"
            size="sm"
            key={tab}
            role="tab"
            aria-selected={active}
            aria-current={active ? "page" : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(tab)}
          >
            {tab[0]!.toUpperCase() + tab.slice(1)}
          </Button>
        );
      })}
    </nav>
  );
}

export function ConfigRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="bot-config-row">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <div className="bot-config-label">{label}</div>}
      <div className="min-w-0">
        {children}
        {hint ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

export function ConfigSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium leading-5 text-foreground">{title}</h2>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-recessed/70">
        {children}
      </div>
    </section>
  );
}
