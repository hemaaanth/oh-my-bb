import { useEffect, useRef, useState } from "react";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
type Project = PluginRpcResult<
  (typeof rpcContract)["organizationSnapshot"]
>["projects"][number];
const controlClass =
  "w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm";
const primaryButtonClass =
  "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50";
const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
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
  onSave: (profile: {
    description: string;
    keywords: string[];
    aliases: string[];
    repositories: string[];
    notFor: string[];
  }) => Promise<unknown>;
  onGenerate: () => Promise<unknown>;
}) {
  const [description, setDescription] = useState(
    project.routingProfile.description,
  );
  const [keywords, setKeywords] = useState(
    project.routingProfile.keywords.join("\n"),
  );
  const [aliases, setAliases] = useState(
    project.routingProfile.aliases.join("\n"),
  );
  const [repositories, setRepositories] = useState(
    project.routingProfile.repositories.join("\n"),
  );
  const [notFor, setNotFor] = useState(
    project.routingProfile.notFor.join("\n"),
  );
  const dirty = useRef(false);
  const draftRevision = useRef(0);

  useEffect(() => {
    if (dirty.current) return;
    setDescription(project.routingProfile.description);
    setKeywords(project.routingProfile.keywords.join("\n"));
    setAliases(project.routingProfile.aliases.join("\n"));
    setRepositories(project.routingProfile.repositories.join("\n"));
    setNotFor(project.routingProfile.notFor.join("\n"));
  }, [project.id, project.routingProfile]);

  const canSave = Boolean(description.trim());
  return (
    <div
      className="mt-4 min-w-0 space-y-4"
      onChange={() => {
        dirty.current = true;
        draftRevision.current++;
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
          {project.routingProfile.source === "none"
            ? "Not generated"
            : project.routingProfile.source === "manual"
              ? "Edited"
              : "Generated"}
        </span>
        <div className="flex gap-2">
          <button
            className={`${controlClass} hover:bg-secondary disabled:opacity-50`}
            disabled={busy || !configured}
            onClick={() => void onGenerate()}
          >
            {project.routingProfile.source === "none"
              ? "Generate"
              : "Regenerate"}
          </button>
          <button
            className={primaryButtonClass}
            disabled={busy || !canSave}
            onClick={() => {
              const revision = draftRevision.current;
              void onSave({
                description: description.trim(),
                keywords: lines(keywords),
                aliases: lines(aliases),
                repositories: lines(repositories),
                notFor: notFor
                  .split(/\r?\n/u)
                  .map((item) => item.trim())
                  .filter(Boolean),
              }).then((saved) => {
                if (saved && draftRevision.current === revision)
                  dirty.current = false;
              });
            }}
          >
            Save profile
          </button>
        </div>
      </div>
      <div className="mt-4 grid min-w-0 gap-4">
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          What this project is for
          <textarea
            className={`${controlClass} min-h-24 resize-y py-2`}
            placeholder="A qualitative description of the product, domain, and work that belongs here."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Keywords
          <textarea
            className={`${controlClass} min-h-28 resize-y py-2`}
            placeholder={"One phrase per line\ncustomer portal\nbilling"}
            value={keywords}
            onChange={(event) => setKeywords(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Names and aliases
          <textarea
            className={`${controlClass} min-h-28 resize-y py-2`}
            placeholder={
              "One name per line\nproduct nickname\nteam abbreviation"
            }
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          Repositories and linked task sources
          <textarea
            className={`${controlClass} min-h-20 resize-y py-2`}
            placeholder={"owner/repository\nLinear · Project name"}
            value={repositories}
            onChange={(event) => setRepositories(event.target.value)}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          Not for
          <textarea
            className={`${controlClass} min-h-20 resize-y py-2`}
            placeholder={
              "Requests that mention this project but belong elsewhere, one per line\nUsing the product for unrelated work\nQuestions about past threads"
            }
            value={notFor}
            onChange={(event) => setNotFor(event.target.value)}
          />
        </label>
        <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
          <span>
            Learned from your routing history
            {project.routingProfile.learnedAt
              ? ` · updated ${new Date(project.routingProfile.learnedAt).toLocaleDateString()}`
              : ""}
          </span>
          {project.routingProfile.learnedFor.length ||
          project.routingProfile.learnedNotFor.length ? (
            <div className="grid gap-2 rounded-md border border-border px-3 py-2 text-foreground">
              {project.routingProfile.learnedFor.length ? (
                <p>
                  <span className="text-muted-foreground">Belongs here: </span>
                  {project.routingProfile.learnedFor.join(" · ")}
                </p>
              ) : null}
              {project.routingProfile.learnedNotFor.length ? (
                <p>
                  <span className="text-muted-foreground">Not here: </span>
                  {project.routingProfile.learnedNotFor.join(" · ")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
