import type { ReactElement } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon, type IconName } from "./ui/icon";
import { menuItemClass } from "./ThreadMenu";
import { usePortalScopeProps } from "../lib/portal-scope";
import {
  GROUP_LABELS,
  SORT_LABELS,
  subgroupChoices,
  withGroup,
  type GroupDimension,
  type SidebarViewOptions,
  type SortMode,
  type SubgroupDimension,
} from "../lib/sidebar-view";

export interface SectionMenuAction {
  key: string;
  label: string;
  icon: IconName;
  destructive?: boolean;
  onSelect: () => void;
}

const contentClass =
  "z-50 min-w-40 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md";
const NO_SUBGROUP = "none";

// Right-click (or long-press) on any section header. Section actions come
// first; the view options below them change the whole sidebar.
export function SectionContextMenu({
  label,
  actions = [],
  view,
  onViewChange,
  projectsEnabled = true,
  children,
}: {
  label: string;
  actions?: readonly SectionMenuAction[];
  view: SidebarViewOptions;
  onViewChange: (next: SidebarViewOptions) => void;
  projectsEnabled?: boolean;
  children: ReactElement;
}) {
  const scopeProps = usePortalScopeProps();
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...scopeProps}
          aria-label={`${label} section actions`}
          className={contentClass}
        >
          {actions.map((action) => (
            <ContextMenu.Item
              key={action.key}
              onSelect={action.onSelect}
              className={menuItemClass(action.destructive)}
            >
              <Icon name={action.icon} className="size-4 shrink-0" aria-hidden="true" />
              <span>{action.label}</span>
            </ContextMenu.Item>
          ))}
          {actions.length > 0 ? (
            <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
          ) : null}
          <ViewSubmenu
            label="Group by"
            value={view.group}
            current={GROUP_LABELS[view.group]}
            choices={(Object.keys(GROUP_LABELS) as GroupDimension[]).filter((group) => projectsEnabled || group !== "workspace").map(
              (group) => ({ value: group, label: GROUP_LABELS[group] }),
            )}
            onChange={(group) =>
              onViewChange(withGroup(view, group as GroupDimension))
            }
          />
          <ViewSubmenu
            label="Subgroup by"
            value={view.subgroup ?? NO_SUBGROUP}
            current={view.subgroup ? GROUP_LABELS[view.subgroup] : "None"}
            choices={[
              { value: NO_SUBGROUP, label: "None" },
              ...subgroupChoices(view.group).filter((subgroup) => projectsEnabled || subgroup !== "workspace").map((subgroup) => ({
                value: subgroup,
                label: GROUP_LABELS[subgroup],
              })),
            ]}
            onChange={(subgroup) =>
              onViewChange({
                ...view,
                subgroup:
                  subgroup === NO_SUBGROUP
                    ? null
                    : (subgroup as SubgroupDimension),
              })
            }
          />
          <ViewSubmenu
            label="Sort by"
            value={view.sort}
            current={SORT_LABELS[view.sort]}
            choices={(Object.keys(SORT_LABELS) as SortMode[]).map((sort) => ({
              value: sort,
              label: SORT_LABELS[sort],
            }))}
            onChange={(sort) => onViewChange({ ...view, sort: sort as SortMode })}
          />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function ViewSubmenu({
  label,
  value,
  current,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  current: string;
  choices: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const scopeProps = usePortalScopeProps();
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={menuItemClass()}>
        <span>{label}</span>
        <span className="ms-auto ps-3 text-muted-foreground">{current}</span>
        <Icon name="ChevronRight" className="size-3 shrink-0" aria-hidden="true" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          {...scopeProps}
          className={contentClass}
        >
          <ContextMenu.RadioGroup value={value} onValueChange={(next) => { if (choices.some((choice) => choice.value === next)) onChange(next); }}>
            {choices.map((choice) => (
              <ContextMenu.RadioItem
                key={choice.value}
                value={choice.value}
                className={menuItemClass()}
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  <ContextMenu.ItemIndicator>
                    <Icon name="Check" className="size-3.5" aria-hidden="true" />
                  </ContextMenu.ItemIndicator>
                </span>
                <span>{choice.label}</span>
              </ContextMenu.RadioItem>
            ))}
          </ContextMenu.RadioGroup>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
