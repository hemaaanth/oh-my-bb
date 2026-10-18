// The CSS each page block's shadow root gets: the plugin's own Tailwind build (dist/app.css), a small reset
// in place of the one BB's app provides, and a bridge from the tokens app.css reads to the page's --bb-*
// tokens, which inherit into the shadow root. So a block follows the page theme, light or dark.

// Chrome ignores @property inside a shadow root. Tailwind's own fallback for browsers without @property sets the
// same initial values on every element; it is wrapped in an @supports that only matches Safari and Firefox.
const FALLBACK = /@layer properties\{@supports [^{]*\{(\*,:before,:after,::backdrop\{[^}]*\})/u;

const RESET = `@layer base {
  *, ::before, ::after, ::backdrop { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
  h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
  ol, ul, menu { list-style: none; }
  a { color: inherit; text-decoration: inherit; }
  b, strong { font-weight: 600; }
  code, kbd, samp, pre { font-family: var(--font-mono); font-size: 1em; }
  table { border-collapse: collapse; border-color: inherit; text-indent: 0; }
  img, svg, video, canvas, iframe { display: block; vertical-align: middle; }
  img, video { max-width: 100%; height: auto; }
  button, input, select, optgroup, textarea, ::file-selector-button { font: inherit; color: inherit; letter-spacing: inherit; background-color: transparent; border-radius: 0; opacity: 1; }
  button, [role="button"] { cursor: pointer; }
  ::placeholder { opacity: 1; color: var(--muted-foreground); }
  textarea { resize: vertical; }
  [hidden]:where(:not([hidden="until-found"])) { display: none !important; }
}`;

// The tokens app.css reads, from the page's --bb-* tokens. Square corners and no soft shadows, like the site;
// floating surfaces get a hard offset.
const BRIDGE = `
  --background: var(--bb-bg); --foreground: var(--bb-text); --muted: var(--bb-surface); --muted-foreground: var(--bb-muted);
  --subtle-foreground: var(--bb-muted); --border: var(--bb-rule); --border-hairline: var(--bb-rule); --input: var(--bb-link-line);
  --ring: var(--bb-accent); --primary: var(--bb-accent); --primary-foreground: #fff; --success: var(--bb-positive);
  --destructive: var(--bb-negative); --warning: var(--bb-warning); --pin: var(--bb-warning); --state-hover: var(--bb-hover);
  --card: var(--bb-bg); --popover: var(--bb-bg); --popover-foreground: var(--bb-text);
  --font-sans: var(--bb-font-sans); --font-mono: var(--bb-font-mono); --radius: 0px;
  --shadow: none; --shadow-md: 3px 3px 0 0 var(--bb-rule); --shadow-lg: 4px 4px 0 0 var(--bb-rule);`;

const TOKENS = `:host {
  display: block; margin-block: var(--bb-space-block, 1.5rem); color: var(--foreground);
  font-family: var(--font-sans); font-size: var(--bb-size-small, 0.875rem); line-height: 1.5; text-align: start;${BRIDGE}
}`;

const LIGHT = /:where\(:root\) \{([^}]*)\}/u;
const DARK = /:where\(:root:has\(> body\.dark\)\),[^{]*\{([^}]*)\}/u;

/**
 * CSS for `selector` that gives the components the shared-site look inside BB: the page tokens from theme.css,
 * light or dark, and the same bridge page blocks get. The settings gallery uses it.
 */
export function siteLook(themeCss: string, selector: string, dark: boolean): string {
  const tokens = (dark ? DARK : LIGHT).exec(themeCss)?.[1] ?? "";
  return `${selector} {${tokens}${BRIDGE}
  background: var(--bb-bg); color: var(--foreground); font-family: var(--font-sans);
}`;
}

/** The shadow-root CSS for page blocks, from the plugin's built app.css. */
export function pageCss(appCss: string): string {
  const fallback = FALLBACK.exec(appCss)?.[1];
  return [
    "@layer properties, theme, base, components, utilities;",
    RESET,
    fallback ? `@layer properties { ${fallback} }` : "",
    appCss,
    TOKENS,
  ].join("\n");
}
