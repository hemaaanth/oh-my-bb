// MingCute glyphs as React components. icons.generated.tsx makes one per name the kit uses.
import type { JSX, SVGProps } from "react";

export type GlyphPath = { d: string; fillRule?: "evenodd"; opacity?: string };
export type IconComponent = (props: SVGProps<SVGSVGElement>) => JSX.Element;

/** An icon on MingCute's 24px grid, filled with the text colour. Size it with a class, as before. */
export function glyph(paths: GlyphPath[]): IconComponent {
  return (props) => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" {...props}>
    {paths.map((path, index) => <path key={index} d={path.d} fillRule={path.fillRule} opacity={path.opacity} />)}
  </svg>;
}
