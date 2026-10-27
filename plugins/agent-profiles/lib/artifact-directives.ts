const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// ::page{id version height?} is canonical. ::artifact{id revision} is the old alias:
// imported artifact ids are page ids and revision ids are version ids.
const DIRECTIVE = /::(page|artifact)\{([^}\r\n]*)\}/gu;
const ATTRIBUTES = { page: { version: "version", allowed: ["id", "version", "height"] }, artifact: { version: "revision", allowed: ["id", "revision"] } } as const;

type Fence = { marker: "`" | "~"; length: number };

/** `revision` holds the page version id for both directive forms. */
export type ArtifactReference = {
  id: string;
  revision: string;
};

export type ArtifactDirectiveSegment =
  | { kind: "text"; text: string }
  | { kind: "artifact"; source: string; reference: ArtifactReference };

function fenceAt(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  if (!match) return null;
  return {
    marker: match[1]![0] as Fence["marker"],
    length: match[1]!.length,
  };
}

function closesFence(line: string, fence: Fence) {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line);
  return Boolean(
    match &&
      match[1]![0] === fence.marker &&
      match[1]!.length >= fence.length,
  );
}

function referenceFrom(name: keyof typeof ATTRIBUTES, body: string): ArtifactReference | null {
  const { version: versionKey, allowed } = ATTRIBUTES[name];
  const attributes = new Map<string, string>();
  const attribute = /\s*([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=}]+))/gyu;
  let offset = 0;
  while (offset < body.length) {
    attribute.lastIndex = offset;
    const match = attribute.exec(body);
    if (!match || match.index !== offset || attributes.has(match[1]!) || !(allowed as readonly string[]).includes(match[1]!)) return null;
    attributes.set(match[1]!, match[2] ?? match[3] ?? match[4] ?? "");
    offset = attribute.lastIndex;
  }
  const id = attributes.get("id");
  const revision = attributes.get(versionKey);
  if (!id || !revision || !UUID.test(id) || !UUID.test(revision)) return null;
  return { id, revision };
}

function appendText(segments: ArtifactDirectiveSegment[], text: string) {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.kind === "text") previous.text += text;
  else segments.push({ kind: "text", text });
}

function parseLine(line: string, segments: ArtifactDirectiveSegment[]) {
  let offset = 0;
  for (const match of line.matchAll(DIRECTIVE)) {
    const source = match[0];
    const reference = referenceFrom(match[1] as keyof typeof ATTRIBUTES, match[2]!);
    if (!reference) continue;
    appendText(segments, line.slice(offset, match.index));
    segments.push({ kind: "artifact", source, reference });
    offset = match.index + source.length;
  }
  appendText(segments, line.slice(offset));
}

export function parseArtifactDirectives(text: string): ArtifactDirectiveSegment[] {
  const segments: ArtifactDirectiveSegment[] = [];
  let fence: Fence | null = null;
  for (const line of text.match(/.*(?:\r?\n|$)/gu) ?? []) {
    if (!line) continue;
    const content = line.replace(/\r?\n$/u, "");
    if (fence) {
      appendText(segments, line);
      if (closesFence(content, fence)) fence = null;
      continue;
    }
    const openingFence = fenceAt(content);
    if (openingFence) {
      fence = openingFence;
      appendText(segments, line);
      continue;
    }
    parseLine(line, segments);
  }
  return segments;
}

/** The Pages library opens the page given by `?page=`. */
export function pageHref(reference: ArtifactReference) {
  return `/plugins/pages/pages?${new URLSearchParams({ page: reference.id }).toString()}`;
}
