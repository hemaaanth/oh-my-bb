import { useState } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Profile } from "../../server/contract";
import { modelLevelLabel } from "../../server/model-levels";
import { Button } from "@/components/ui/button";
import { Menu } from "../shared/menu";
import { ErrorMessage } from "../shared/ui";
import {
  ResourceListPanel,
  ResourceListState,
  ResourceRow,
  ResourceToolbar,
} from "../shared/resource-list";

export function AgentCollection({
  profiles,
  loading,
  error,
}: {
  profiles: Profile[];
  loading: boolean;
  error: string | null;
}) {
  const navigate = useBbNavigate();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "default">("all");
  const [sort, setSort] = useState<"name" | "recent">("name");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const search = query.trim().toLowerCase();
  const visible = profiles
    .filter((profile) =>
      `${profile.name} @${profile.slug} ${profile.description}`.toLowerCase().includes(search) &&
      (status === "all" || profile.isDefault),
    )
    .sort((left, right) => sort === "recent"
      ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      : left.name.localeCompare(right.name));

  return (
    <div className="h-full overflow-y-auto" data-agents-collection>
      <div className="mx-auto box-border flex w-full max-w-5xl flex-col gap-5 px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm leading-5 text-muted-foreground">
          Create and manage reusable full and thin agent profiles.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-sm font-medium">
            {status === "default" ? "Default agent" : "All agents"}{" "}
            <span className="text-2xs text-subtle-foreground">{visible.length}</span>
          </span>
          <Button size="sm" onClick={() => navigate.toPluginPanel("agents", { subPath: "new" })}>
            <Icon name="Plus" /> New agent
          </Button>
        </div>
        <ResourceToolbar
          value={query}
          onChange={setQuery}
          controls={
            <>
              <Menu label="Filter agents" open={filterOpen} onOpenChange={setFilterOpen} trigger={
                <Button
                  variant="outline"
                  size="icon"
                  className={`size-8 p-0 text-muted-foreground ${
                    status !== "all" ? "border-transparent bg-state-active text-foreground" : ""
                  }`}
                  aria-label="Filter agents"
                  aria-pressed={status !== "all"}
                >
                  <Icon name="SlidersHorizontal" className="size-4" />
                </Button>
              }>
                <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Status</p>
                {([[
                  "all",
                  "All agents",
                ], [
                  "default",
                  "Default agent",
                ]] as const).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-state-hover"
                    aria-pressed={status === value}
                    onClick={() => {
                      setStatus(value);
                      setFilterOpen(false);
                    }}
                  >
                    <span className="flex-1">{label}</span>
                    {status === value ? <Icon name="Check" /> : null}
                  </button>
                ))}
              </Menu>
              <Menu label="Sort agents" open={sortOpen} onOpenChange={setSortOpen} trigger={
                <Button
                  variant="outline"
                  size="icon"
                  className={`size-8 p-0 text-muted-foreground ${
                    sort !== "name" ? "border-transparent bg-state-active text-foreground" : ""
                  }`}
                  aria-label="Sort agents"
                  aria-pressed={sort !== "name"}
                >
                  <Icon name="ArrowUpDown" className="size-4" />
                </Button>
              }>
                {([[
                  "name",
                  "Name",
                ], [
                  "recent",
                  "Recently updated",
                ]] as const).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-state-hover"
                    aria-pressed={sort === value}
                    onClick={() => {
                      setSort(value);
                      setSortOpen(false);
                    }}
                  >
                    <span className="flex-1">{label}</span>
                    {sort === value ? <Icon name="Check" /> : null}
                  </button>
                ))}
              </Menu>
            </>
          }
        />
        <ErrorMessage error={error} />
        {loading ? (
          <ResourceListState state="loading" message="Loading agents…" loadingRows={5} />
        ) : !profiles.length ? (
          <ResourceListState
            state="empty"
            message="No agents yet. Create your first agent to get started."
          />
        ) : !visible.length ? (
          <ResourceListState
            state="empty"
            message="No agents match your search or filters."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <ResourceListPanel>
            {visible.map((profile) => (
              <ResourceRow
                key={profile.id}
                leading={profile.avatar}
                title={profile.name}
                titleMeta={`@${profile.slug} · ${profile.modelMode === "level" ? modelLevelLabel(profile.level) : profile.model}`}
                description={profile.description}
                state={
                  <>
                    {profile.kind === "thin" ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                        Thin
                      </span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {profile.isDefault ? "Default" : `Revision ${profile.revision}`}
                    </span>
                  </>
                }
                onOpen={() => navigate.toPluginPanel("agents", { subPath: `${profile.id}/profile` })}
              />
            ))}
          </ResourceListPanel>
        )}
      </div>
    </div>
  );
}
