// Diagram's nodes and edges as Mermaid flowchart text. No Pele or React here: the server's Markdown export uses it too.
type Tone = "neutral" | "info" | "success" | "warning" | "danger";
type Node = { id: string; label: string; tone: Tone };
type Edge = { from: string; to: string; label?: string };

const tones: Record<string, true> = { neutral: true, info: true, success: true, warning: true, danger: true };
const quote = (text: string) => `"${text.replace(/\s+/g, " ").trim().replace(/"/g, "#quot;")}"`;

/** The first node per id, with the label defaulting to the id; edges between known nodes only. */
export function diagramGraph(rawNodes: readonly unknown[], rawEdges: readonly unknown[]): { nodes: Node[]; edges: Edge[] } {
  const nodes = new Map<string, Node>();
  for (const raw of rawNodes) {
    const node = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const id = typeof node.id === "string" ? node.id : "";
    if (!id || nodes.has(id)) continue;
    nodes.set(id, { id, label: typeof node.label === "string" && node.label ? node.label : id, tone: typeof node.tone === "string" && tones[node.tone] ? node.tone as Tone : "neutral" });
  }
  const edges: Edge[] = [];
  for (const raw of rawEdges) {
    const edge = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (typeof edge.from === "string" && typeof edge.to === "string" && nodes.has(edge.from) && nodes.has(edge.to)) edges.push({ from: edge.from, to: edge.to, label: typeof edge.label === "string" ? edge.label : undefined });
  }
  return { nodes: [...nodes.values()], edges };
}

/** Mermaid flowchart text. Node ids become n0, n1… so ids like "end" or "a b" are safe. */
export function diagramSource(nodes: readonly Node[], edges: readonly Edge[], right: boolean): string {
  const key = new Map(nodes.map((node, i) => [node.id, `n${i}`]));
  return [
    `flowchart ${right ? "LR" : "TD"}`,
    ...nodes.map((node) => `  ${key.get(node.id)}[${quote(node.label)}]${node.tone === "neutral" ? "" : `:::tone-${node.tone}`}`),
    ...edges.flatMap((edge) => key.has(edge.from) && key.has(edge.to) ? [`  ${key.get(edge.from)} -->${edge.label ? `|${quote(edge.label)}|` : ""} ${key.get(edge.to)}`] : []),
  ].join("\n");
}
