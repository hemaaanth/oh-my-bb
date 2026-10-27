import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { IconActionTooltip } from "../shared/menu";
import { insertMarkdownLink, prefixMarkdown, wrapMarkdown, type MarkdownCommand } from "./markdown-commands";
import { applyTextareaEdit, syncTextareaValue } from "./markdown-textarea";

const bold = wrapMarkdown("**", "bold text");
const italic = wrapMarkdown("*", "italic text");
const formats: { label: string; icon: ReactNode; command: MarkdownCommand }[] = [
  { label: "Bold", icon: <strong aria-hidden="true">B</strong>, command: bold },
  { label: "Italic", icon: <em aria-hidden="true">I</em>, command: italic },
  { label: "Heading", icon: <span aria-hidden="true">H₂</span>, command: prefixMarkdown("## ") },
  { label: "Bullet list", icon: <Icon name="ListView" />, command: prefixMarkdown("- ") },
  {
    label: "Insert link",
    icon: (
      <svg
        aria-hidden="true"
        data-icon-root=""
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2" />
      </svg>
    ),
    command: insertMarkdownLink,
  },
];
const shortcuts: Record<string, MarkdownCommand> = { b: bold, i: italic };

export function MarkdownEditor({
  id,
  label,
  value,
  disabled,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const [preview, setPreview] = useState(false);

  useLayoutEffect(() => {
    if (textarea.current) syncTextareaValue(textarea.current, value);
  }, [value]);

  const run = (command: MarkdownCommand) => {
    const editor = textarea.current;
    if (!editor || disabled || preview) return;
    applyTextareaEdit(editor, command({ text: editor.value, start: editor.selectionStart, end: editor.selectionEnd }));
  };
  const history = (action: "undo" | "redo") => {
    const editor = textarea.current;
    if (!editor || disabled || preview) return;
    editor.focus();
    document.execCommand(action);
  };

  return (
    <div
      className="bot-markdown-editor"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          callbacks.current.onSave();
        }
      }}
    >
      <div className="bot-markdown-header">
        <span className="bot-markdown-filename">{label}</span>
        <div className="bot-markdown-modes" role="group" aria-label="Document view">
          <Button size="sm" variant="ghost" aria-pressed={!preview} onClick={() => setPreview(false)}>Edit</Button>
          <Button size="sm" variant="ghost" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</Button>
        </div>
      </div>
      <div className="bot-markdown-tools" role="group" aria-label="Markdown tools" hidden={preview}>
        {formats.map((format) => (
          <IconActionTooltip key={format.label} label={format.label}>
            <Button
              size="icon"
              variant="ghost"
              aria-label={format.label}
              disabled={disabled}
              onClick={() => run(format.command)}
            >
              {format.icon}
            </Button>
          </IconActionTooltip>
        ))}
        <span className="bot-markdown-tools-spacer" />
        <IconActionTooltip label="Undo">
          <Button size="icon" variant="ghost" aria-label="Undo" disabled={disabled} onClick={() => history("undo")}>
            <Icon name="ArrowTurnBackward" />
          </Button>
        </IconActionTooltip>
        <IconActionTooltip label="Redo">
          <Button size="icon" variant="ghost" aria-label="Redo" disabled={disabled} onClick={() => history("redo")}>
            <Icon name="ArrowTurnForward" />
          </Button>
        </IconActionTooltip>
      </div>
      <textarea
        // A new document gets a fresh textarea and undo history.
        key={`${id}:${label}`}
        ref={textarea}
        id={id}
        className="bot-markdown-source"
        aria-label={label}
        aria-multiline="true"
        defaultValue={value}
        readOnly={disabled}
        hidden={preview}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="soft"
        onChange={(event) => callbacks.current.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          const command = shortcuts[event.key.toLowerCase()];
          if (!command || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
          event.preventDefault();
          run(command);
        }}
      />
      {preview ? (
        <div className="bot-markdown-preview" role="region" aria-label={`${label} preview`} tabIndex={0}>
          {value.trim() ? <Markdown content={value} /> : <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>}
        </div>
      ) : null}
    </div>
  );
}
