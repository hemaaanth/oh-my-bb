import { useId } from "react";

// Picker marks for the ACP agents this plugin sets up. provider-acp draws every
// customAgents entry with its generic Toolbox glyph and accepts no logo field.

/** The fx glyph from https://fx.sh. */
export function FxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="166.241 0 155.861 156" fill="currentColor" aria-hidden="true">
      <path d="M237.89 0C243.18 0 249.38 1.42 253.03 3.07L255.09 4.01L250.08 18.63L247.68 17.75C244.9 16.72 241.94 15.8 238.49 15.8C234.98 15.8 232.79 16.56 231.08 18.32C229.23 20.23 227.63 23.64 226.23 29.76L225.14 34.85H241.67L260.43 34.95L260.69 34.95L260.84 35.17L278.85 61.63L296.74 34.95H320.87L291.68 76.74L322.1 119.75H299.33L299.18 119.55L241.14 40.48L239.35 49.4H222.07L205.69 127.21C203.93 135.71 201.19 142.84 196.78 147.87C192.27 153.01 186.2 155.75 178.34 155.75C174.18 155.75 170.75 155.11 167.91 154.11L166.24 153.52V137.18L166.9 137.4L169.53 138.28C172.18 139.16 174.41 139.8 177.14 139.8C178.53 139.8 179.7 139.53 180.73 138.98C181.76 138.43 182.68 137.6 183.52 136.44C185.3 133.99 186.72 130.13 187.9 124.67L203.76 49.4H189.87L191.76 39.44L192.04 39.35L206.82 34.47L208.15 28.64C210.52 18.21 213.77 10.94 218.71 6.32C223.74 1.61 230.13 0 237.89 0ZM273.99 99.08L260.07 120.25H234.54L261 82.02L273.99 99.08Z" />
    </svg>
  );
}

/**
 * The nanocodex app icon (gakonst/nanocodex assets/nanocodex/icon.svg) redrawn on
 * a 24px grid without its dot: the N is cut out of the tile so it works on light and dark themes.
 */
export function NanocodexIcon({ className }: { className?: string }) {
  const mask = `nanocodex-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <mask id={mask}>
        <rect width="24" height="24" fill="#fff" />
        <path
          d="M8.75 16.5V7.5L15.25 16.5V7.5"
          fill="none"
          stroke="#000"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </mask>
      <rect x="2" y="2" width="20" height="20" rx="5.5" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}
