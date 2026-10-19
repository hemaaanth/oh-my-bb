export const GLYPHS: Record<string, string>;
export function iconKey(name: string): string;
export function generate(svgRoot: string): { json: string; spec: string; doc: string; counts: { line: number; fill: number } };
