import { useId, useState } from "react";
import { Icon } from "./ui/icon.js";
export function ImagePackageTags({
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
