/** The editor text and its current selection, as offsets into `text`. */
export type MarkdownSelection = { text: string; start: number; end: number };

/** Replace `text[from, to)` with `insert`, then select `[selectionStart, selectionEnd)`. */
export type MarkdownEdit = {
  from: number;
  to: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
};

export type MarkdownCommand = (selection: MarkdownSelection) => MarkdownEdit;

export function applyMarkdownEdit(text: string, edit: MarkdownEdit): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

const oddRun = (run: string | undefined) => (run?.length ?? 0) % 2 === 1;

/**
 * Toggle an inline marker around the selection: unwrap when the selection
 * includes or is surrounded by the marker, otherwise wrap it (or the
 * placeholder when nothing is selected) and select the wrapped text.
 */
export function wrapMarkdown(marker: string, placeholder: string): MarkdownCommand {
  const size = marker.length;
  // A lone "*" only counts as italic when it is not half of a "**" bold run.
  const italic = marker === "*";
  return ({ text, start: from, end: to }) => {
    const selected = text.slice(from, to);
    const includesMarkers =
      (!italic || (oddRun(selected.match(/^\*+/)?.[0]) && oddRun(selected.match(/\*+$/)?.[0]))) &&
      selected.length >= size * 2 &&
      selected.startsWith(marker) &&
      selected.endsWith(marker);
    if (includesMarkers) {
      const content = selected.slice(size, -size);
      return { from, to, insert: content, selectionStart: from, selectionEnd: from + content.length };
    }
    const wrapped =
      (!italic || (oddRun(text.slice(0, from).match(/\*+$/)?.[0]) && oddRun(text.slice(to).match(/^\*+/)?.[0]))) &&
      from >= size &&
      text.slice(from - size, from) === marker &&
      text.slice(to, to + size) === marker;
    if (wrapped) {
      return {
        from: from - size,
        to: to + size,
        insert: selected,
        selectionStart: from - size,
        selectionEnd: from - size + selected.length,
      };
    }
    const content = selected || placeholder;
    return {
      from,
      to,
      insert: `${marker}${content}${marker}`,
      selectionStart: from + size,
      selectionEnd: from + size + content.length,
    };
  };
}

/**
 * Toggle a line prefix on every line the selection touches. A selection that
 * ends at the very start of a line leaves that line alone. The prefix is
 * removed only when every touched line already has it.
 */
export function prefixMarkdown(prefix: string): MarkdownCommand {
  return ({ text, start, end }) => {
    const lineStart = (pos: number) => text.lastIndexOf("\n", pos - 1) + 1;
    const lineEnd = (pos: number) => {
      const index = text.indexOf("\n", pos);
      return index === -1 ? text.length : index;
    };
    const from = lineStart(start);
    const to = lineEnd(end > start && lineStart(end) === end ? end - 1 : end);
    const lines = text.slice(from, to).split("\n");
    const remove = lines.every((line) => line.startsWith(prefix));
    const insert = lines
      .map((line) => (remove ? line.slice(prefix.length) : prefix + line))
      .join("\n");
    const map = (pos: number) => {
      if (pos > to) return pos + insert.length - (to - from);
      let lineFrom = from;
      let mapped = from;
      for (const line of lines) {
        const column = pos - lineFrom;
        if (column <= line.length) {
          return mapped + (remove ? Math.max(0, column - prefix.length) : column + prefix.length);
        }
        mapped += (remove ? line.length - prefix.length : line.length + prefix.length) + 1;
        lineFrom += line.length + 1;
      }
      return pos;
    };
    return { from, to, insert, selectionStart: map(start), selectionEnd: map(end) };
  };
}

/** Wrap the selection (or placeholder text) in a link and select the URL. */
export const insertMarkdownLink: MarkdownCommand = ({ text, start: from, end: to }) => {
  const label = text.slice(from, to) || "link text";
  const url = "https://";
  const urlStart = from + label.length + 3;
  return {
    from,
    to,
    insert: `[${label}](${url})`,
    selectionStart: urlStart,
    selectionEnd: urlStart + url.length,
  };
};
