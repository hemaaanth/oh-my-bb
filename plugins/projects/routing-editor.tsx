import { useEffect, useId, useRef, useState } from "react";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
type Project = PluginRpcResult<
  (typeof rpcContract)["organizationSnapshot"]
>["projects"][number];
type Profile = Pick<
  Project["routingProfile"],
  "description" | "keywords" | "aliases" | "repositories" | "notFor"
>;
const input =
  "w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
function Tags({
  label,
  values,
  onChange,
  max,
  length,
}: {
  label: string;
  values: string[];
  onChange(v: string[]): void;
  max: number;
  length: number;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  function add() {
    const additions = draft
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean);
    if (!additions.length) return;
    const next = [...new Set([...values, ...additions])];
    if (next.length > max || next.some((v) => v.length > length)) {
      setError(
        `Use up to ${max} entries, each under ${length + 1} characters.`,
      );
      return;
    }
    onChange(next);
    setDraft("");
    setError("");
  }
  return (
    <div className="min-w-0 space-y-1.5">
      <label className="text-xs font-medium" htmlFor={id}>
        {label}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
        {values.map((value, i) => (
          <span
            key={`${i}-${value}`}
            className="inline-flex max-w-full items-center gap-1 rounded bg-secondary px-2 py-0.5 text-xs"
          >
            <span className="min-w-0 break-words">{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value} from ${label}`}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-background"
              onClick={() => onChange(values.filter((_, n) => n !== i))}
            >
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          className="h-7 min-w-20 flex-1 bg-transparent px-1 text-xs outline-none"
          placeholder="Add…"
          value={draft}
          maxLength={length}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function RoutingProfileEditor({
  project,
  busy,
  configured,
  onSave,
  onGenerate,
}: {
  project: Project;
  busy: boolean;
  configured: boolean;
  onSave(profile: Profile): Promise<unknown>;
  onGenerate(): Promise<unknown>;
}) {
  const [draft, setDraft] = useState<Profile>(project.routingProfile);
  const [changed, setChanged] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    if (!changed) setDraft(project.routingProfile);
  }, [project.routingProfile, changed]);
  function patch(p: Partial<Profile>) {
    revision.current++;
    setChanged(true);
    setDraft((old) => ({ ...old, ...p }));
  }
  return (
    <div className="min-w-0 space-y-4 pt-2">
      <p className="text-xs text-muted-foreground">
        Helps BB suggest this project when you start a new thread. These
        descriptions do not grant access or change an agent’s instructions.
      </p>
      <label className="grid gap-1.5 text-xs font-medium">
        Description
        <textarea
          className={`${input} min-h-24 resize-y`}
          maxLength={1200}
          value={draft.description}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="What work belongs in this project?"
        />
      </label>
      <Tags
        label="Keywords"
        values={draft.keywords}
        onChange={(keywords) => patch({ keywords })}
        max={24}
        length={80}
      />
      <Tags
        label="Names and aliases"
        values={draft.aliases}
        onChange={(aliases) => patch({ aliases })}
        max={16}
        length={100}
      />
      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium">
          Repositories and exclusions
        </summary>
        <div className="mt-3 space-y-3">
          <Tags
            label="Repositories"
            values={draft.repositories}
            onChange={(repositories) => patch({ repositories })}
            max={16}
            length={240}
          />
          <Tags
            label="Not for"
            values={draft.notFor}
            onChange={(notFor) => patch({ notFor })}
            max={8}
            length={240}
          />
        </div>
      </details>
      {!!(
        project.routingProfile.learnedFor.length ||
        project.routingProfile.learnedNotFor.length
      ) && (
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-xs">
            Saved routing guidance
          </summary>
          <div className="mt-2 space-y-2 text-xs text-muted-foreground">
            {project.routingProfile.learnedFor.length > 0 && (
              <p>
                Belongs here: {project.routingProfile.learnedFor.join(" · ")}
              </p>
            )}
            {project.routingProfile.learnedNotFor.length > 0 && (
              <p>
                Not here: {project.routingProfile.learnedNotFor.join(" · ")}
              </p>
            )}
          </div>
        </details>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">
          {project.routingProfile.source === "manual"
            ? "Custom description"
            : project.routingProfile.source === "none"
              ? "No description yet"
              : "AI-generated description"}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !changed || !draft.description.trim()}
          onClick={() => {
            const sent = revision.current;
            void onSave({
              ...draft,
              description: draft.description.trim(),
            }).then((ok) => {
              if (ok && revision.current === sent) setChanged(false);
            });
          }}
        >
          Save description
        </Button>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Generate from repository with AI
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-muted-foreground">
            Reads the repository README and package metadata. Uses your saved
            model and may incur cost. Replaces this routing description and its
            tags.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !configured}
            onClick={() => {
              const sent = revision.current;
              void onGenerate().then((ok) => {
                if (ok && sent === revision.current) setChanged(false);
              });
            }}
          >
            Generate description
          </Button>
          {!configured && (
            <p className="text-muted-foreground">
              Add an OpenRouter API key in Configuration first.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
